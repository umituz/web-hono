/* Fetch-backed reactive cache — the client twin of the thin-read/fat-write
   doctrine. The app owns its Database shape, endpoint map and empty-state
   factory (that IS the app); this module owns the machine: hydrate-every-
   collection-once, targeted refresh after writes, synchronous reads and
   per-collection pub/sub. `apiWrite` comes back bound to the store, so the
   whole client glue per app is one `createStore` call. */

import { ApiClientError, apiFetch, apiWrite as clientApiWrite } from './client';

export interface StoreConfig<Database extends object> {
  /** API endpoint per collection key (e.g. orders → '/api/orders'). */
  endpoints: Record<keyof Database & string, string>;
  /** Fresh empty cache — the pre-hydration state (arrays, singleton defaults). */
  empty: () => Database;
  /** OPT-IN copy-on-write: every load installs a NEW array reference per
   *  collection (React memo-safe, makes view() memoization identity-sound).
   *  Default false = the 1.x in-place semantics, unchanged. */
  immutable?: boolean;
  /** Chunked single-round hydration through GET /api/bootstrap (default on):
   *  collections load in small sequential batches, one request per batch,
   *  instead of one fan-out request per collection — the server wakes its
   *  database once and later batches run warm. APIs predating the bootstrap
   *  route answer 404 and hydration silently falls back to the 1.x fan-out.
   *  `false` pins the legacy mode; the object form tunes the batch size
   *  (default 12 — a replayed route may run a couple of queries of its own,
   *  so the batch keeps one Worker request inside the free-tier subrequest
   *  budget). */
  bootstrap?: boolean | { chunk?: number };
}

/** Wildcard channel: every emit also pings its subscribers (useQuery). */
export const REFETCH_ALL = '__refetch_all__';

const BOOTSTRAP_ENDPOINT = '/api/bootstrap';
const BOOTSTRAP_CHUNK = 12;

interface BootstrapEntry {
  status: number;
  body?: unknown;
}

/** Sentinel: the server has no /api/bootstrap (pre-1.10 API) — hydrate the
 *  remaining collections the 1.x way instead of retrying batches. */
class BootstrapUnavailable extends Error {}

type Listener = () => void;

export function createStore<Database extends object>(config: StoreConfig<Database>) {
  const { endpoints, empty, immutable = false } = config;
  const bootstrap =
    config.bootstrap === undefined || config.bootstrap === true
      ? { chunk: BOOTSTRAP_CHUNK }
      : config.bootstrap === false
        ? null
        : { chunk: config.bootstrap.chunk ?? BOOTSTRAP_CHUNK };
  const keys = Object.keys(endpoints) as (keyof Database & string)[];
  const cache: Database = empty(); // mutated in place as collections load
  let hydration: Promise<void> | null = null;

  const listeners = new Map<string, Set<Listener>>();
  /** Per-collection change counter — view() memoization anchor. */
  const versions = new Map<string, number>();

  function emit(key: string) {
    versions.set(key, (versions.get(key) ?? 0) + 1);
    listeners.get(key)?.forEach((l) => l());
    listeners.get(REFETCH_ALL)?.forEach((l) => l());
  }

  async function loadCollection(key: keyof Database & string): Promise<void> {
    // Rows arrive domain-shaped (drizzle serializes property names; dates as
    // ISO strings). Singleton collections return their one row — same call.
    // immutable mode installs a fresh array reference — memo identity for
    // React consumers (singletons get a fresh reference either way).
    // Auth-gated endpoints (401/403) leave the collection at its empty state
    // instead of failing the whole hydration — anonymous visitors keep the
    // app usable; every other failure still rejects.
    let rows: unknown;
    try {
      rows = await apiFetch<unknown>(endpoints[key]);
    } catch (err) {
      if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) return;
      throw err;
    }
    (cache as Record<string, unknown>)[key] = immutable && Array.isArray(rows) ? [...rows] : rows;
  }

  function install(key: keyof Database & string, rows: unknown): void {
    (cache as Record<string, unknown>)[key] = immutable && Array.isArray(rows) ? [...rows] : rows;
  }

  /** Load collections through /api/bootstrap in sequential batches. Emits
   *  per collection as its batch lands (subscribers render progressively);
   *  keys the bundle could not serve fall through to loadCollection. Throws
   *  BootstrapUnavailable when the API predates the route. */
  async function hydrateChunked(loaded: Set<string>, chunk: number): Promise<void> {
    const urls = [...new Set(keys.map((key) => endpoints[key]))];
    const keysByUrl = new Map<string, (keyof Database & string)[]>();
    for (const key of keys) {
      const url = endpoints[key];
      const bucket = keysByUrl.get(url);
      if (bucket) bucket.push(key);
      else keysByUrl.set(url, [key]);
    }

    for (let i = 0; i < urls.length; i += chunk) {
      const group = urls.slice(i, i + chunk);
      const query = `?paths=${group.map(encodeURIComponent).join(',')}`;
      let results: Record<string, BootstrapEntry> | undefined;
      try {
        results = ((await apiFetch<{ results?: Record<string, BootstrapEntry> }>(BOOTSTRAP_ENDPOINT + query)) ?? {}).results;
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 404) throw new BootstrapUnavailable();
        continue; // batch-level failure — its keys hydrate per-collection below
      }
      const pending: (keyof Database & string)[] = [];
      for (const url of group) {
        const entry = results?.[url];
        if (entry?.status === 200 && entry.body !== undefined) {
          for (const key of keysByUrl.get(url) ?? []) {
            install(key, entry.body);
            loaded.add(key);
            emit(key);
          }
        } else {
          pending.push(...(keysByUrl.get(url) ?? []));
        }
      }
      if (pending.length > 0) {
        await Promise.all(pending.map(loadCollection));
        for (const key of pending) {
          loaded.add(key);
          emit(key);
        }
      }
    }
  }

  /** Fetch every collection once and populate the cache — one bootstrap
   *  batch at a time when available, otherwise the 1.x parallel fan-out. */
  function ensureHydrated(): Promise<void> {
    if (!hydration) {
      hydration = (async () => {
        const loaded = new Set<string>();
        if (bootstrap) {
          try {
            await hydrateChunked(loaded, bootstrap.chunk);
          } catch (err) {
            if (!(err instanceof BootstrapUnavailable)) throw err;
          }
        }
        const remaining = keys.filter((key) => !loaded.has(key));
        if (remaining.length > 0) {
          await Promise.all(remaining.map(loadCollection));
          remaining.forEach(emit);
        }
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

  /** Wildcard subscription: fires on every collection change — boot gates,
   *  devtools. (Every key emit also pings the wildcard channel.) */
  function subscribeAll(cb: Listener): () => void {
    return subscribe([REFETCH_ALL], cb);
  }

  /** The repository prologue in one call: hydrates once, then runs the
   *  selector against the live cache — replaces the `await ensureHydrated();
   *  const db = getDb()` pair every 1.x repo method repeated. */
  function read<T>(fn: (db: Database) => T): Promise<T> {
    return ensureHydrated().then(() => fn(cache));
  }

  /** Raw client facade, so apps stop re-exporting it — retires the
   *  per-app src/data/http.ts file. `write` is the store-bound apiWrite. */
  const http = { fetch: apiFetch, write: apiWrite };

  /** Derived read with change-detection: recomputes only when one of
   *  `keys` has loaded/emitted since the previous call. Tenant/derived
   *  views stop being hand-rolled per app:
   *    const activeOrg = view(['organizations'], (db) =>
   *      db.organizations.find((o) => o.id === currentOrgId)); */
  function view<T>(viewKeys: ReadonlyArray<keyof Database & string>, selector: (db: Database) => T): () => T {
    let lastSig = ' '; // never matches a real signature
    let memo: T;
    return () => {
      const sig = viewKeys.map((k) => versions.get(k) ?? 0).join(',');
      if (sig !== lastSig) {
        memo = selector(cache);
        lastSig = sig;
      }
      return memo;
    };
  }

  /** Debug/devtools helper: a shallow per-collection copy of the cache —
   *  mutating it never touches the store. */
  function snapshot(): Database {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(cache)) {
      const v = (cache as Record<string, unknown>)[key];
      out[key] = Array.isArray(v) ? [...v] : v;
    }
    return out as Database;
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

  // 1.x surface first (unchanged), then the 1.3 additions.
  return { ensureHydrated, refresh, getDb, subscribe, emit, apiWrite, read, http, view, subscribeAll, snapshot };
}
