// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createStore } from '../src/store';
import { makeStoreHooks } from '../src/store-react';

/* The 1.3 hooks against a stubbed fetch: useCollection's channel
   re-render and the useHydration boot gate (ready + error/retry). */

interface Row {
  id: string;
}
interface Db {
  items: Row[];
  flag: { on: boolean };
}

function stubFetch(handlers: Record<string, () => unknown>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const payload = handlers[key]?.();
    return new Response(JSON.stringify(payload ?? null), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeStore() {
  return createStore<Db>({
    endpoints: { items: '/api/items', flag: '/api/flag' },
    empty: (): Db => ({ items: [], flag: { on: false } }),
  });
}

describe('useCollection', () => {
  it('returns the collection and re-renders when it reloads', async () => {
    let rows = [{ id: 'v1' }];
    stubFetch({
      'GET /api/items': () => rows,
      'GET /api/flag': () => ({ on: false }),
    });
    const store = makeStore();
    const { useCollection } = makeStoreHooks(store);

    const { result } = renderHook(() => useCollection('items'));
    expect(result.current).toEqual([]); // empty until hydrated
    await act(async () => {
      await store.ensureHydrated();
    });
    expect(result.current).toEqual([{ id: 'v1' }]);

    rows = [{ id: 'v2' }];
    await act(async () => {
      await store.refresh(['items']);
    });
    expect(result.current).toEqual([{ id: 'v2' }]);
  });
});

describe('useHydration', () => {
  it('goes loading → ready once the store hydrates', async () => {
    stubFetch({
      'GET /api/items': () => [],
      'GET /api/flag': () => ({ on: false }),
    });
    const store = makeStore();
    const { useHydration } = makeStoreHooks(store);

    const { result } = renderHook(() => useHydration());
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('surfaces hydration errors and retries successfully', async () => {
    let failing = true;
    stubFetch({
      'GET /api/items': () => {
        if (failing) throw new Error('network down');
        return [{ id: 'late' }];
      },
      'GET /api/flag': () => ({ on: false }),
    });
    const store = makeStore();
    const { useHydration } = makeStoreHooks(store);

    const { result } = renderHook(() => useHydration());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('network down');

    failing = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(store.getDb().items).toEqual([{ id: 'late' }]);
  });
});
