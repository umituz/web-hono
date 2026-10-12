/* Fetch-backed reactive cache — the client twin of the thin-read/fat-write
   doctrine. The app owns its Database shape, endpoint map and empty-state
   factory (that IS the app); this module owns the machine: hydrate-every-
   collection-once, targeted refresh after writes, synchronous reads and
   per-collection pub/sub. `apiWrite` comes back bound to the store, so the
   whole client glue per app is one `createStore` call. */

import { apiFetch, apiWrite as clientApiWrite } from './client';

export interface StoreConfig<Database extends object> {
  /** API endpoint per collection key (e.g. orders → '/api/orders'). */
  endpoints: Record<keyof Database & string, string>;
  /** Fresh empty cache — the pre-hydration state (arrays, singleton defaults). */
  empty: () => Database;
}

/** Wildcard channel: every emit also pings its subscribers (useQuery). */
export const REFETCH_ALL = '__refetch_all__';

type Listener = () => void;

export function createStore<Database extends object>(config: StoreConfig<Database>) {
  const { endpoints, empty } = config;
  const keys = Object.keys(endpoints) as (keyof Database & string)[];
  const cache: Database = empty(); // mutated in place as collections load
  let hydration: Promise<void> | null = null;

  const listeners = new Map<string, Set<Listener>>();

  function emit(key: string) {
    listeners.get(key)?.forEach((l) => l());
    listeners.get(REFETCH_ALL)?.forEach((l) => l());
  }

  async function loadCollection(key: keyof Database & string): Promise<void> {
    // Rows arrive domain-shaped (drizzle serializes property names; dates as
    // ISO strings). Singleton collections return their one row — same call.
    (cache as Record<string, unknown>)[key] = await apiFetch<unknown>(endpoints[key]);
  }

  /** Fetch every collection once (parallel) and populate the cache. */
  function ensureHydrated(): Promise<void> {
    if (!hydration) {
      hydration = (async () => {
        await Promise.all(keys.map((key) => loadCollection(key)));
        keys.forEach(emit); // per-collection subscribers
        emit(REFETCH_ALL); // useQuery subscribers
      })().catch((err) => {
        hydration = null; // next reader retries
        throw err;
      });
    }
    return hydration;
  }

  /** Re-fetch the given collections after a write, then invalidate subscribers. */
  async function refresh(collectionKeys: ReadonlyArray<keyof Database & string>): Promise<void> {
    await Promise.all(collectionKeys.map((key) => loadCollection(key)));
    collectionKeys.forEach(emit);
  }

  /** Synchronous cache read (empty until first hydration completes). */
  function getDb(): Database {
    return cache;
  }

  function subscribe(collectionKeys: string[], cb: Listener): () => void {
    const disposers = collectionKeys.map((key) => {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(cb);
      return () => listeners.get(key)?.delete(cb);
    });
    return () => disposers.forEach((d) => d());
  }

  /** The repository write idiom, bound: mutate through the API, then refresh
   *  the collections the write touched. Refresh only runs when the write
   *  succeeded — failures leave the cache untouched. */
  function apiWrite<T = void>(
    path: string,
    init: { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; json?: unknown },
    collectionKeys: ReadonlyArray<keyof Database & string> = [],
  ): Promise<T> {
    return clientApiWrite<T>(path, init, [...collectionKeys], (keys) => refresh(keys as (keyof Database & string)[]));
  }

  return { ensureHydrated, refresh, getDb, subscribe, emit, apiWrite };
}
