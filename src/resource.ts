/** Default TTL for cached resources — one minute of warm navigations. */
export const RESOURCE_TTL_MS = 60_000;

export interface Resource<T> {
  /** Cached value without loading; null when nothing valid was loaded. */
  read(): T | null;
  write(value: T): void;
  subscribe(listener: () => void): () => void;
  ensure(): Promise<T | null>;
  refresh(): Promise<T | null>;
  clear(): void;
}

export interface ResourceConfig<T> {
  /** Network (or other async) source of truth. */
  load: () => Promise<T>;
  /** localStorage persistence key, or null for memory-only. */
  storageKey: string | null;
  /** Validates stored JSON; a null return ignores the persisted value. */
  decode?: (stored: unknown) => T | null;
  ttlMs: number;
}

const memoryStore = new Map<string, string>();

function readStored(key: string): unknown {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    raw = memoryStore.get(key) ?? null;
  }
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown): void {
  const raw = JSON.stringify(value);
  try {
    localStorage.setItem(key, raw);
  } catch {
    memoryStore.set(key, raw);
  }
}

function dropStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {}
  memoryStore.delete(key);
}

/**
 * A TTL-cached async value: read() synchronously, ensure() (deduped,
 * in-flight shared) or refresh() from the network, subscribe() for
 * React re-renders, optional localStorage persistence behind decode().
 * Loads swallow errors and keep the last good value — a failed refresh
 * never blanks a warm cache.
 */
export function createResource<T>(config: ResourceConfig<T>): Resource<T> {
  const stored = config.storageKey === null ? null : readStored(config.storageKey);
  let value: T | null = stored === null || config.decode === undefined ? null : config.decode(stored);
  let expiresAt = 0;
  let inflight: Promise<T | null> | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  }

  function fetch(): Promise<T | null> {
    const run = (async () => {
      try {
        const next = await config.load();
        value = next;
        expiresAt = Date.now() + config.ttlMs;
        if (config.storageKey !== null) writeStored(config.storageKey, next);
        notify();
        return next;
      } catch {
        return value;
      } finally {
        inflight = null;
      }
    })();
    inflight = run;
    return run;
  }

  return {
    read: () => value,
    write: (next: T) => {
      value = next;
      expiresAt = Date.now() + config.ttlMs;
      if (config.storageKey !== null) writeStored(config.storageKey, next);
      notify();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure: () => {
      if (inflight !== null) return inflight;
      if (value !== null && Date.now() < expiresAt) return Promise.resolve(value);
      return fetch();
    },
    refresh: () => {
      if (inflight !== null) return inflight;
      return fetch();
    },
    clear: () => {
      value = null;
      expiresAt = 0;
      inflight = null;
      if (config.storageKey !== null) dropStored(config.storageKey);
      notify();
    },
  };
}
