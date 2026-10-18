import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { docStore, WorkflowError } from '../src/docstore';
import { makeTestDb, resetOrgDb, testEnv } from './pglite';
import { docsDocs, docsUsers } from './helpers';
import type { CrudDb } from '../src/crud';
import type { ApiEnv } from '../src/env';

/* REAL-database coverage (in-memory Postgres) of the jsonb doc-store
 * factory — the exact architecture 30+ fleet apps hand-copied at ~500
 * lines each: doc-verbatim wire, epoch-ms trio, upsert revive, status
 * machines, singleton guard, typed user columns, and the batch op loop. */

let db: CrudDb;

const FLOW: Record<string, string[]> = { draft: ['review'], review: ['done'] };

function makeStore() {
  return docStore({
    collections: [
      { key: 'docs', table: docsDocs, transitions: FLOW },
      { key: 'tanks', table: docsDocs, transitions: FLOW, statusKey: 'state' },
      {
        key: 'settings',
        table: docsDocs,
        singletonId: 'app',
      },
      {
        key: 'users',
        table: docsUsers,
        columns: (doc) => ({ email: String(doc.email ?? ''), name: String(doc.name ?? '') }),
      },
    ],
    db: () => db,
  });
}

function app() {
  const store = makeStore();
  const hono = new Hono<{ Bindings: ApiEnv }>();
  hono.route('/data', store.router);
  return { hono, store };
}

beforeEach(async () => {
  db = await makeTestDb();
  await resetOrgDb();
});

describe('docStore motor', () => {
  it('puts a doc, lists it verbatim, and gets it by id', async () => {
    const { store } = app();
    await store.putDoc(db, 'docs', { id: 'd1', title: 'Spec', status: 'draft' });
    expect(await store.listDocs(db, 'docs')).toEqual([{ id: 'd1', title: 'Spec', status: 'draft' }]);
    expect(await store.getDoc(db, 'docs', 'd1')).toEqual({ id: 'd1', title: 'Spec', status: 'draft' });
  });

  it('upserting a soft-deleted doc revives it', async () => {
    const { store } = app();
    await store.putDoc(db, 'docs', { id: 'd1', title: 'A' });
    expect(await store.softDeleteDoc(db, 'docs', 'd1')).toBe(true);
    expect(await store.listDocs(db, 'docs')).toEqual([]);
    await store.putDoc(db, 'docs', { id: 'd1', title: 'B' });
    expect(await store.listDocs(db, 'docs')).toEqual([{ id: 'd1', title: 'B' }]);
  });

  it('enforces the status machine and allows staying put', async () => {
    const { store } = app();
    await store.putDoc(db, 'docs', { id: 'd1', status: 'draft' });
    await store.putDoc(db, 'docs', { id: 'd1', status: 'draft' });
    await store.putDoc(db, 'docs', { id: 'd1', status: 'review' });
    await expect(store.putDoc(db, 'docs', { id: 'd1', status: 'draft' })).rejects.toBeInstanceOf(WorkflowError);
    expect((await store.getDoc(db, 'docs', 'd1'))!.status).toBe('review');
  });

  it('patches a live doc into a merged shape and stamps ISO updatedAt', async () => {
    const { store } = app();
    await store.putDoc(db, 'docs', { id: 'd1', title: 'A', nested: { k: 1 } });
    const merged = await store.patchDoc(db, 'docs', 'd1', { title: 'B' } as never);
    expect(merged).toMatchObject({ id: 'd1', title: 'B', nested: { k: 1 } });
    expect(typeof merged!.updatedAt).toBe('string');
    expect((await store.getDoc(db, 'docs', 'd1'))!.title).toBe('B');
  });

  it('patching a missing id upserts a fresh doc', async () => {
    const { store } = app();
    const merged = await store.patchDoc(db, 'docs', 'fresh', { title: 'N' } as never);
    expect(merged).toMatchObject({ id: 'fresh', title: 'N' });
    expect(await store.getDoc(db, 'docs', 'fresh')).toMatchObject({ title: 'N' });
  });

  it('guards transitions through a custom statusKey field', async () => {
    const { store } = app();
    await store.putDoc(db, 'tanks', { id: 't1', state: 'draft' });
    await store.putDoc(db, 'tanks', { id: 't1', state: 'draft' });
    await store.putDoc(db, 'tanks', { id: 't1', state: 'review' });
    await expect(store.putDoc(db, 'tanks', { id: 't1', state: 'draft' })).rejects.toBeInstanceOf(WorkflowError);
    expect((await store.getDoc(db, 'tanks', 't1'))!.state).toBe('review');
  });

  it('guards the singleton id', async () => {
    const { store } = app();
    await store.putDoc(db, 'settings', { id: 'app', theme: 'dark' });
    await expect(store.putDoc(db, 'settings', { id: 'other' })).rejects.toBeInstanceOf(WorkflowError);
    expect(await store.getDoc(db, 'settings', 'app')).toMatchObject({ theme: 'dark' });
  });

  it('derives typed columns on the users table', async () => {
    const { store } = app();
    await store.putDoc(db, 'users', { id: 'u1', email: 'a@b.c', name: 'Ada', role: 'admin' });
    const rows = await db.select().from(docsUsers);
    expect(rows[0]).toMatchObject({ email: 'a@b.c', name: 'Ada' });
    expect(await store.listDocs(db, 'users')).toEqual([{ id: 'u1', email: 'a@b.c', name: 'Ada', role: 'admin' }]);
  });

  it('unknown collections throw UnknownCollectionError', async () => {
    const { store } = app();
    await expect(store.listDocs(db, 'ghosts')).rejects.toThrow("Unknown collection 'ghosts'");
  });

  it('putDocs bulk-loads in chunks and upserts over existing rows', async () => {
    const { store } = app();
    const first = await store.putDocs(db, 'docs', [
      { id: 'b', title: 'B' },
      { id: 'a', title: 'A' },
    ]);
    expect(first).toBe(2);
    const second = await store.putDocs(db, 'docs', [{ id: 'a', title: 'A2' }, { id: 'c', title: 'C' }], 1);
    expect(second).toBe(2);
    expect(await store.listDocs(db, 'docs')).toEqual([
      { id: 'a', title: 'A2' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ]);
  });
});

describe('docStore validate hook', () => {
  it('sees existing on updates and undefined on fresh inserts', async () => {
    const seen: Array<{ docTitle: unknown; existingTitle: unknown }> = [];
    const store = docStore({
      collections: [
        {
          key: 'docs',
          table: docsDocs,
          validate: ({ doc, existing }) => {
            seen.push({ docTitle: doc.title, existingTitle: existing?.title });
          },
        },
      ],
      db: () => db,
    });
    await store.putDoc(db, 'docs', { id: 'a', title: 'A' });
    await store.putDoc(db, 'docs', { id: 'a', title: 'B' });
    expect(seen).toEqual([
      { docTitle: 'A', existingTitle: undefined },
      { docTitle: 'B', existingTitle: 'A' },
    ]);
  });

  it('rejects the write when the guard throws and leaves the row untouched', async () => {
    const store = docStore({
      collections: [
        {
          key: 'docs',
          table: docsDocs,
          validate: ({ doc }) => {
            if (doc.title === 'bad') throw new WorkflowError('bad title');
          },
        },
      ],
      db: () => db,
    });
    await store.putDoc(db, 'docs', { id: 'a', title: 'ok' });
    await expect(store.putDoc(db, 'docs', { id: 'a', title: 'bad' })).rejects.toThrow('bad title');
    expect((await store.getDoc(db, 'docs', 'a'))!.title).toBe('ok');
  });

  it('validates the merged doc on PATCH', async () => {
    const store = docStore({
      collections: [
        {
          key: 'docs',
          table: docsDocs,
          validate: ({ doc }) => {
            if (doc.title === 'bad') throw new WorkflowError('bad title');
          },
        },
      ],
      db: () => db,
    });
    await store.putDoc(db, 'docs', { id: 'a', title: 'ok' });
    await expect(store.patchDoc(db, 'docs', 'a', { title: 'bad' } as never)).rejects.toThrow('bad title');
    expect((await store.getDoc(db, 'docs', 'a'))!.title).toBe('ok');
  });

  it('supports async cross-doc guards reading through the db', async () => {
    const store = docStore({
      collections: [
        {
          key: 'docs',
          table: docsDocs,
          validate: async ({ db: conn, doc }) => {
            const all = await store.listDocs(conn, 'docs');
            if (all.some((d) => d.id !== doc.id && d.title === doc.title)) {
              throw new WorkflowError('Title already used');
            }
          },
        },
      ],
      db: () => db,
    });
    await store.putDoc(db, 'docs', { id: 'a', title: 'X' });
    await expect(store.putDoc(db, 'docs', { id: 'b', title: 'X' })).rejects.toThrow('Title already used');
    await store.putDoc(db, 'docs', { id: 'b', title: 'Y' });
    expect(await store.listDocs(db, 'docs')).toHaveLength(2);
  });

  it('guards batch puts with the partial-progress envelope', async () => {
    const store = docStore({
      collections: [
        {
          key: 'docs',
          table: docsDocs,
          validate: ({ doc }) => {
            if ((doc as { boom?: boolean }).boom) throw new WorkflowError('boom');
          },
        },
      ],
      db: () => db,
    });
    const hono = new Hono<{ Bindings: ApiEnv }>();
    hono.route('/data', store.router);
    const res = await hono.request('/data/batch', {
      method: 'POST',
      body: JSON.stringify({
        ops: [
          { op: 'put', collection: 'docs', doc: { id: 'a', title: 'A' } },
          { op: 'put', collection: 'docs', doc: { id: 'b', boom: true } },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ applied: 1, error: 'boom' });
  });

  it('putDocs seed loads bypass the guard', async () => {
    let calls = 0;
    const store = docStore({
      collections: [
        {
          key: 'docs',
          table: docsDocs,
          validate: () => {
            calls += 1;
          },
        },
      ],
      db: () => db,
    });
    await store.putDocs(db, 'docs', [{ id: 'a' }, { id: 'b' }]);
    expect(calls).toBe(0);
    await store.putDoc(db, 'docs', { id: 'c' });
    expect(calls).toBe(1);
  });
});

describe('docStore routes', () => {
  it('serves the doc-verbatim list and unknown-collection 404', async () => {
    const { hono, store } = app();
    await store.putDoc(db, 'docs', { id: 'a', title: 'A' });
    const list = await hono.request('/data/docs', undefined, testEnv());
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([{ id: 'a', title: 'A' }]);
    const ghost = await hono.request('/data/ghosts', undefined, testEnv());
    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toEqual({ error: 'Unknown collection', collection: 'ghosts' });
  });

  it('GET one doc and the Document-not-found 404', async () => {
    const { hono, store } = app();
    await store.putDoc(db, 'docs', { id: 'a' });
    expect((await hono.request('/data/docs/a', undefined, testEnv())).status).toBe(200);
    const miss = await hono.request('/data/docs/nope', undefined, testEnv());
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ error: 'Document not found' });
  });

  it('PUT returns 201 and rejects a body/url id mismatch with 400', async () => {
    const { hono } = app();
    const put = await hono.request('/data/docs/a', {
      method: 'PUT',
      body: JSON.stringify({ id: 'a', title: 'A' }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(put.status).toBe(201);
    expect(await put.json()).toEqual({ id: 'a', title: 'A' });
    const mismatch = await hono.request('/data/docs/a', {
      method: 'PUT',
      body: JSON.stringify({ id: 'b' }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ error: 'Body id does not match the URL' });
  });

  it('PUT of an invalid transition answers the WorkflowError 400 envelope', async () => {
    const { hono } = app();
    await hono.request('/data/docs/a', {
      method: 'PUT',
      body: JSON.stringify({ id: 'a', status: 'draft' }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    await hono.request('/data/docs/a', {
      method: 'PUT',
      body: JSON.stringify({ id: 'a', status: 'review' }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    const bad = await hono.request('/data/docs/a', {
      method: 'PUT',
      body: JSON.stringify({ id: 'a', status: 'draft' }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid docs transition review → draft' });
  });

  it('PATCH merges and DELETE hides behind the ok envelope', async () => {
    const { hono } = app();
    await hono.request('/data/docs/a', {
      method: 'PUT',
      body: JSON.stringify({ id: 'a', title: 'A' }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    const patched = await hono.request('/data/docs/a', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'B' }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ id: 'a', title: 'B' });
    const gone = await hono.request('/data/docs/a', { method: 'DELETE' }, testEnv());
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ ok: true });
    expect((await hono.request('/data/docs/a', undefined, testEnv())).status).toBe(404);
    const twice = await hono.request('/data/docs/a', { method: 'DELETE' }, testEnv());
    expect(twice.status).toBe(200);
  });

  it('batch applies put and del ops and reports partial progress on failure', async () => {
    const { hono } = app();
    const ok = await hono.request('/data/batch', {
      method: 'POST',
      body: JSON.stringify({
        ops: [
          { op: 'put', collection: 'docs', doc: { id: 'a', status: 'draft' } },
          { op: 'put', collection: 'docs', doc: { id: 'b', status: 'draft' } },
          { op: 'del', collection: 'docs', id: 'a' },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, applied: 3 });
    const after = await hono.request('/data/docs', undefined, testEnv());
    expect(await after.json()).toEqual([{ id: 'b', status: 'draft' }]);
    const bad = await hono.request('/data/batch', {
      method: 'POST',
      body: JSON.stringify({
        ops: [
          { op: 'put', collection: 'docs', doc: { id: 'b', status: 'review' } },
          { op: 'put', collection: 'ghosts', doc: { id: 'x' } },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(bad.status).toBe(404);
    expect(await bad.json()).toMatchObject({ applied: 1 });
  });

  it('rejects an empty patch and an unknown-key batch envelope', async () => {
    const { hono } = app();
    const empty = await hono.request('/data/docs/a', {
      method: 'PATCH',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(empty.status).toBe(400);
    const bogus = await hono.request('/data/batch', {
      method: 'POST',
      body: JSON.stringify({ ops: [] }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(bogus.status).toBe(400);
  });
});
