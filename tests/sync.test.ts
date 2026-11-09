import { afterEach, describe, expect, it, vi } from 'vitest';
import { diffOps, pushOps, pushOpsKeepalive, snapshotDocs } from '../src/sync';
import type { SyncCollections, SyncOp } from '../src/sync';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('snapshotDocs', () => {
  it('keys every doc by collection and id with stable JSON', () => {
    const snap = snapshotDocs({ notes: [{ id: 'n1', text: 'hi' }] });
    expect(snap.get('notes:n1')).toBe('{"id":"n1","text":"hi"}');
  });

  it('strips configured fields from the comparison payload without mutating the doc', () => {
    const collections: SyncCollections = { learner: [{ id: 'learner', hearts: 3, updatedAt: 't2' }] };
    const snap = snapshotDocs(collections, { learner: ['updatedAt'] });
    expect(snap.get('learner:learner')).toBe('{"id":"learner","hearts":3}');
    expect(collections.learner?.[0]?.updatedAt).toBe('t2');
  });

  it('skips stripping for collections without an entry', () => {
    const snap = snapshotDocs({ notes: [{ id: 'n1', updatedAt: 't1' }] }, { learner: ['updatedAt'] });
    expect(snap.get('notes:n1')).toBe('{"id":"n1","updatedAt":"t1"}');
  });
});

describe('diffOps', () => {
  const strip = { learner: ['updatedAt'] };

  it('emits put ops for new and changed docs', () => {
    const before = new Map([['notes:n1', '{"id":"n1","text":"a"}']]);
    const ops = diffOps(before, { notes: [{ id: 'n1', text: 'b' }, { id: 'n2', text: 'new' }] });
    expect(ops).toEqual([
      { op: 'put', collection: 'notes', doc: { id: 'n1', text: 'b' } },
      { op: 'put', collection: 'notes', doc: { id: 'n2', text: 'new' } },
    ]);
  });

  it('emits del ops for docs that disappeared', () => {
    const before = new Map([
      ['notes:n1', '{"id":"n1"}'],
      ['notes:n2', '{"id":"n2"}'],
    ]);
    const ops = diffOps(before, { notes: [{ id: 'n2' }] });
    expect(ops).toEqual([{ op: 'del', collection: 'notes', id: 'n1' }]);
  });

  it('returns no ops when snapshots match', () => {
    const docs: SyncCollections = { notes: [{ id: 'n1', text: 'a' }] };
    const before = snapshotDocs(docs);
    expect(diffOps(before, docs)).toEqual([]);
  });

  it('ignores stripped field churn but ships the full doc on real changes', () => {
    const docs: SyncCollections = { learner: [{ id: 'learner', hearts: 3, updatedAt: 't1' }] };
    const before = snapshotDocs(docs, strip);
    const quiet = diffOps(before, { learner: [{ id: 'learner', hearts: 3, updatedAt: 't999' }] }, strip);
    expect(quiet).toEqual([]);
    const loud = diffOps(before, { learner: [{ id: 'learner', hearts: 4, updatedAt: 't2' }] }, strip);
    expect(loud).toEqual([{ op: 'put', collection: 'learner', doc: { id: 'learner', hearts: 4, updatedAt: 't2' } }]);
  });
});

describe('pushOps', () => {
  it('posts ops in chunk-sized batches to the endpoint', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const ops: SyncOp[] = [
      { op: 'put', collection: 'notes', doc: { id: 'n1' } },
      { op: 'put', collection: 'notes', doc: { id: 'n2' } },
      { op: 'del', collection: 'notes', id: 'n3' },
    ];
    await pushOps('/api/docs/batch', ops, 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/docs/batch');
    expect(firstInit.method).toBe('POST');
    expect(JSON.parse(firstInit.body as string)).toEqual({ ops: ops.slice(0, 2) });
    expect(JSON.parse(secondInit.body as string)).toEqual({ ops: ops.slice(2) });
  });

  it('propagates failures so callers keep their snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(500, { error: 'boom' })));
    const ops: SyncOp[] = [{ op: 'del', collection: 'notes', id: 'n1' }];
    await expect(pushOps('/api/docs/batch', ops, 10)).rejects.toThrow('boom');
  });
});

describe('pushOpsKeepalive', () => {
  it('sends keepalive posts and skips chunks over the body limit', () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const ops: SyncOp[] = [
      { op: 'put', collection: 'notes', doc: { id: 'n1', text: 'x'.repeat(40) } },
      { op: 'put', collection: 'notes', doc: { id: 'n2', text: 'small' } },
    ];
    pushOpsKeepalive('/api/docs/batch', ops, 1, 100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/docs/batch');
    expect(init?.method).toBe('POST');
    expect(init?.keepalive).toBe(true);
    expect(JSON.parse(init?.body as string)).toEqual({ ops: [ops[1]] });
  });
});
