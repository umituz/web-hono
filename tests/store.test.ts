import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, REFETCH_ALL } from '../src/store';

/* The store machine is exercised entirely through a stubbed fetch — no
   server, no React. foodora is the live E2E proof; these tests pin the
   contract: hydrate-once, selective refresh, pub/sub, write-then-refresh. */

interface Row {
  id: string;
}
interface Flag {
  on: boolean;
}
interface Db {
  items: Row[];
  flag: Flag; // singleton row, not an array
}

function makeStore() {
  return createStore<Db>({
    endpoints: { items: '/api/items', flag: '/api/flag' },
    empty: (): Db => ({ items: [], flag: { on: false } }),
  });
}

/** Fetch stub keyed by `METHOD url`; a handler returns a payload (JSON) or a
 *  Response (for failures). Every call is logged for call-count assertions. */
function stubFetch(handlers: Record<string, () => unknown>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    calls.push(key);
    const payload = handlers[key]?.();
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload ?? null), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

const boom = () => new Response('boom', { status: 500 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createStore', () => {
  it('hydrates every collection once (arrays and singleton rows) and reads synchronously', async () => {
    const { calls } = stubFetch({
      'GET /api/items': () => [{ id: 'a' }, { id: 'b' }],
      'GET /api/flag': () => ({ on: true }),
    });
    const store = makeStore();
    expect(store.getDb().items).toEqual([]); // empty until hydrated
    await store.ensureHydrated();
    expect(store.getDb().items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(store.getDb().flag).toEqual({ on: true }); // singleton: single row, not wrapped
    await store.ensureHydrated(); // cached — no second round
    expect(calls.filter((c) => c === 'GET /api/items')).toHaveLength(1);
  });

  it('dedupes concurrent hydration into one fetch round', async () => {
    const { calls } = stubFetch({
      'GET /api/items': () => [],
      'GET /api/flag': () => ({ on: false }),
    });
    const store = makeStore();
    await Promise.all([store.ensureHydrated(), store.ensureHydrated(), store.ensureHydrated()]);
    expect(calls).toHaveLength(2);
  });

  it('resets a failed hydration so the next read retries', async () => {
    let failing = true;
    const { calls } = stubFetch({
      'GET /api/items': () => (failing ? boom() : [{ id: 'late' }]),
      'GET /api/flag': () => ({ on: false }),
    });
    const store = makeStore();
    await expect(store.ensureHydrated()).rejects.toThrow('responded 500');
    failing = false;
    await store.ensureHydrated();
    expect(store.getDb().items).toEqual([{ id: 'late' }]);
    expect(calls.filter((c) => c === 'GET /api/items')).toHaveLength(2);
  });

  it('refresh re-fetches only the given collections', async () => {
    const { calls } = stubFetch({
      'GET /api/items': () => [{ id: 'v2' }],
      'GET /api/flag': () => ({ on: false }),
    });
    const store = makeStore();
    await store.ensureHydrated();
    await store.refresh(['items']);
    expect(store.getDb().items).toEqual([{ id: 'v2' }]);
    expect(calls.filter((c) => c === 'GET /api/flag')).toHaveLength(1); // untouched
    expect(calls.filter((c) => c === 'GET /api/items')).toHaveLength(2);
  });

  it('pub/sub: key listeners fire on their key and on the refetch-all channel; disposers work', async () => {
    stubFetch({
      'GET /api/items': () => [],
      'GET /api/flag': () => ({ on: false }),
    });
    const store = makeStore();
    await store.ensureHydrated(); // hydration itself emits

    const onItems = vi.fn();
    const onAll = vi.fn();
    const stop = store.subscribe(['items'], onItems);
    store.subscribe([REFETCH_ALL], onAll);

    store.emit('flag'); // other key: items listener silent, refetch-all fires
    expect(onItems).not.toHaveBeenCalled();
    expect(onAll).toHaveBeenCalledTimes(1);

    store.emit('items'); // own key: both fire (emit pings the wildcard too)
    expect(onItems).toHaveBeenCalledTimes(1);
    expect(onAll).toHaveBeenCalledTimes(2);

    stop();
    store.emit('items');
    expect(onItems).toHaveBeenCalledTimes(1); // disposed
    expect(onAll).toHaveBeenCalledTimes(3); // wildcard still alive
  });

  it('apiWrite: success writes through the API, refreshes the touched keys and notifies', async () => {
    const { calls } = stubFetch({
      'GET /api/items': () => [{ id: 'old' }],
      'GET /api/flag': () => ({ on: false }),
      'POST /api/items': () => ({ id: 'new' }),
    });
    const store = makeStore();
    await store.ensureHydrated();
    const notified = vi.fn();
    store.subscribe(['items'], notified);

    const created = await store.apiWrite<Row>('/api/items', { method: 'POST', json: { id: 'new' } }, ['items']);
    expect(created).toEqual({ id: 'new' });
    expect(calls.filter((c) => c === 'POST /api/items')).toHaveLength(1);
    expect(calls.filter((c) => c === 'GET /api/items')).toHaveLength(2); // refreshed
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it('apiWrite: a failed write propagates and leaves the cache untouched (no refresh)', async () => {
    const { calls } = stubFetch({
      'GET /api/items': () => [{ id: 'old' }],
      'GET /api/flag': () => ({ on: false }),
      'DELETE /api/items/x': boom,
    });
    const store = makeStore();
    await store.ensureHydrated();
    const notified = vi.fn();
    store.subscribe(['items'], notified);

    await expect(store.apiWrite('/api/items/x', { method: 'DELETE' }, ['items'])).rejects.toThrow('responded 500');
    expect(calls.filter((c) => c === 'GET /api/items')).toHaveLength(1); // no refresh
    expect(notified).not.toHaveBeenCalled();
    expect(store.getDb().items).toEqual([{ id: 'old' }]);
  });
});
