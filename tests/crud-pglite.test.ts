import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createApi } from '../src/api';
import { crudRoutes, listRoutes } from '../src/crud';
import type { CrudDb } from '../src/crud';
import type { ApiEnv } from '../src/env';
import { makeTestDb, resetDb, testEnv } from './pglite';
import { widgets } from './helpers';

/* REAL database coverage of the factory (in-memory Postgres) — the paths
 * 1.x could only prove against live Neon: list/POST/PATCH/DELETE success,
 * soft-delete hiding, unique→409, and the additivity pins. */

const CreateWidgetSchema = z.object({ name: z.string().trim().min(1), count: z.number().int().min(0).optional() }).strict();

interface WidgetRow {
  id: string;
  name: string | null;
  count: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

async function insertWidget(db: CrudDb, row: { id: string; name: string; count?: number; deletedAt?: Date }) {
  await db.insert(widgets).values(row as never);
}

/** App = createApi + crudRoutes with injected pglite db (proves the whole
 *  chain: factory → db injection → onError envelope). */
function makeApp(db: CrudDb, spec: { create?: boolean; remove?: boolean } = {}) {
  return createApi<ApiEnv>({
    service: 'crud-test',
    routers: [
      [
        '/',
        crudRoutes({
          path: '/widgets',
          table: widgets,
          label: 'Widget',
          ...(spec.create && { create: { schema: CreateWidgetSchema, prefix: 'wgt' } }),
          ...(spec.remove && { remove: true }),
          db: () => db,
        }),
      ],
    ],
  });
}

let db: CrudDb;

beforeEach(async () => {
  db = await makeTestDb();
  await resetDb();
});

describe('GET list (real DB)', () => {
  it('hides soft-deleted rows and returns the full visible list without params (1.x shape)', async () => {
    await insertWidget(db, { id: 'w_a', name: 'alpha', count: 3 });
    await insertWidget(db, { id: 'w_b', name: 'bravo', count: 1 });
    await insertWidget(db, { id: 'w_gone', name: 'gone', count: 0, deletedAt: new Date() });

    const res = await makeApp(db).request('/api/widgets', undefined, testEnv());
    expect(res.status).toBe(200);
    const rows = (await res.json()) as WidgetRow[];
    expect(rows.map((r) => r.id)).toEqual(['w_a', 'w_b']);
  });

  it('orders by ?order=col and ?order=-col, whitelisting columns', async () => {
    await insertWidget(db, { id: 'w_a', name: 'alpha' });
    await insertWidget(db, { id: 'w_b', name: 'bravo' });

    const app = makeApp(db);
    const asc = (await (await app.request('/api/widgets?order=name', undefined, testEnv())).json()) as WidgetRow[];
    expect(asc.map((r) => r.name)).toEqual(['alpha', 'bravo']);
    const desc = (await (await app.request('/api/widgets?order=-name', undefined, testEnv())).json()) as WidgetRow[];
    expect(desc.map((r) => r.name)).toEqual(['bravo', 'alpha']);

    const bad = await app.request('/api/widgets?order=bogus; drop table', undefined, testEnv());
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid order column' });
  });

  it('applies ?limit and ?offset, rejecting junk', async () => {
    for (const name of ['a', 'b', 'c', 'd']) await insertWidget(db, { id: `w_${name}`, name });

    const app = makeApp(db);
    const page = (await (await app.request('/api/widgets?order=name&limit=2&offset=1', undefined, testEnv())).json()) as WidgetRow[];
    expect(page.map((r) => r.name)).toEqual(['b', 'c']);

    for (const junk of ['0', '-1', '501', 'abc']) {
      const res = await app.request(`/api/widgets?limit=${junk}`, undefined, testEnv());
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid limit' });
    }
    expect((await app.request('/api/widgets?offset=-3', undefined, testEnv())).status).toBe(400);
  });

  it('accepts multi-key orderBy arrays — ties broken by the second key', async () => {
    await insertWidget(db, { id: 'w_1', name: 'delta', count: 2 });
    await insertWidget(db, { id: 'w_2', name: 'alpha', count: 1 });
    await insertWidget(db, { id: 'w_3', name: 'charlie', count: 2 });
    await insertWidget(db, { id: 'w_4', name: 'bravo', count: 1 });

    const byCountNameDesc = createApi<ApiEnv>({
      service: 'crud-test',
      routers: [['/', crudRoutes({
        path: '/widgets', table: widgets, label: 'Widget',
        orderBy: [{ col: widgets.count }, { col: widgets.name, dir: 'desc' }],
        db: () => db,
      })]],
    });
    const rows = (await (await byCountNameDesc.request('/api/widgets', undefined, testEnv())).json()) as WidgetRow[];
    expect(rows.map((r) => r.id)).toEqual(['w_4', 'w_2', 'w_1', 'w_3']);

    const listed = createApi<ApiEnv>({
      service: 'crud-test',
      routers: [['/', listRoutes({
        path: '/widgets', table: widgets,
        orderBy: [{ col: widgets.count, dir: 'desc' }, { col: widgets.name }],
        db: () => db,
      })]],
    });
    const rows2 = (await (await listed.request('/api/widgets', undefined, testEnv())).json()) as WidgetRow[];
    expect(rows2.map((r) => r.id)).toEqual(['w_3', 'w_1', 'w_2', 'w_4']);
  });
});

describe('PATCH (real DB)', () => {
  it('updates, stamps updatedAt, and 404s misses and soft-deleted rows', async () => {
    await insertWidget(db, { id: 'w_a', name: 'alpha' });
    await insertWidget(db, { id: 'w_gone', name: 'gone', deletedAt: new Date() });

    const app = makeApp(db);
    const res = await app.request('/api/widgets/w_a', {
      method: 'PATCH',
      body: JSON.stringify({ count: 7, id: 'hacked', updatedAt: '2020-01-01T00:00:00Z' }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(res.status).toBe(200);
    const row = (await res.json()) as WidgetRow;
    expect(row.count).toBe(7);
    expect(row.id).toBe('w_a'); // protected keys ignored
    expect(row.updatedAt > '2020-01-01').toBe(true); // stamped now, not client value

    expect((await app.request('/api/widgets/w_nope', { method: 'PATCH', body: JSON.stringify({ count: 1 }), headers: { 'content-type': 'application/json' } }, testEnv())).status).toBe(404);
    expect((await app.request('/api/widgets/w_gone', { method: 'PATCH', body: JSON.stringify({ count: 1 }), headers: { 'content-type': 'application/json' } }, testEnv())).status).toBe(404);
  });
});

describe('POST create (opt-in)', () => {
  it('inserts with a generated uid prefix and answers 201', async () => {
    const res = await makeApp(db, { create: true }).request('/api/widgets', {
      method: 'POST',
      body: JSON.stringify({ name: 'alpha', count: 2 }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(res.status).toBe(201);
    const row = (await res.json()) as WidgetRow;
    expect(row.id).toMatch(/^wgt_/);
    expect(row.name).toBe('alpha');
    expect(row.count).toBe(2);
    expect(row.deletedAt).toBeNull();
  });

  it('applies server defaults UNDER the body — body wins', async () => {
    const app = createApi<ApiEnv>({
      service: 'crud-test',
      routers: [[
        '/',
        crudRoutes({
          path: '/widgets',
          table: widgets,
          label: 'Widget',
          create: {
            schema: CreateWidgetSchema,
            prefix: 'wgt',
            defaults: () => ({ count: 42, name: 'server-name' }),
          },
          db: () => db,
        }),
      ]],
    });
    const res = await app.request('/api/widgets', {
      method: 'POST',
      body: JSON.stringify({ name: 'client-name' }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    const row = (await res.json()) as WidgetRow;
    expect(row.name).toBe('client-name'); // body overrides default
    expect(row.count).toBe(42); // default survives where body is silent
  });

  it('answers 400 with zod fieldErrors for invalid bodies', async () => {
    const res = await makeApp(db, { create: true }).request('/api/widgets', {
      method: 'POST',
      body: JSON.stringify({ name: '', extra: true }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: Record<string, string[]> };
    expect(body.error).toBe('Invalid request body');
    expect(Object.keys(body.details)).toContain('name');
  });

  it('maps a postgres unique violation to 409 through onError', async () => {
    await insertWidget(db, { id: 'w_a', name: 'alpha' });
    const res = await makeApp(db, { create: true }).request('/api/widgets', {
      method: 'POST',
      body: JSON.stringify({ name: 'alpha' }),
      headers: { 'content-type': 'application/json' },
    }, testEnv());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Already exists' });
  });
});

describe('DELETE soft-delete (opt-in)', () => {
  it('soft-deletes: {ok:true}, row leaves the list, second call 404s', async () => {
    await insertWidget(db, { id: 'w_a', name: 'alpha' });
    const app = makeApp(db, { remove: true });

    const res = await app.request('/api/widgets/w_a', { method: 'DELETE' }, testEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const list = (await (await app.request('/api/widgets', undefined, testEnv())).json()) as WidgetRow[];
    expect(list).toHaveLength(0); // hidden from reads…

    const raw = await db.select().from(widgets).where(eq(widgets.id, 'w_a'));
    expect(raw[0]!.deletedAt).not.toBeNull(); // …but history preserved

    expect((await app.request('/api/widgets/w_a', { method: 'DELETE' }, testEnv())).status).toBe(404);
  });
});

describe('additivity pins (1.x compatibility)', () => {
  it('without create/remove: POST and DELETE answer 404, GET+PATCH work', async () => {
    await insertWidget(db, { id: 'w_a', name: 'alpha' });
    const app = makeApp(db); // no create, no remove

    expect((await app.request('/api/widgets', { method: 'POST', body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json' } }, testEnv())).status).toBe(404);
    expect((await app.request('/api/widgets/w_a', { method: 'DELETE' }, testEnv())).status).toBe(404);

    const list = (await (await app.request('/api/widgets', undefined, testEnv())).json()) as WidgetRow[];
    expect(list.map((r) => r.id)).toEqual(['w_a']);
    const patched = await app.request('/api/widgets/w_a', { method: 'PATCH', body: JSON.stringify({ count: 9 }), headers: { 'content-type': 'application/json' } }, testEnv());
    expect(patched.status).toBe(200);
  });

  it('listRoutes accepts db injection and stays GET-only', async () => {
    await insertWidget(db, { id: 'w_a', name: 'alpha' });
    const app = createApi<ApiEnv>({
      service: 'crud-test',
      routers: [['/', listRoutes({ path: '/widgets', table: widgets, db: () => db })]],
    });
    const rows = (await (await app.request('/api/widgets', undefined, testEnv())).json()) as WidgetRow[];
    expect(rows).toHaveLength(1);
    expect((await app.request('/api/widgets/w_a', { method: 'DELETE' }, testEnv())).status).toBe(404);
  });
});
