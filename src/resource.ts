export const RESOURCE_TTL_MS = 60_000;

export interface Resource<T> {
  read(): T | null;
  write(value: T): void;
  subscribe(listener: () => void): () => void;
  ensure(): Promise<T | null>;
  refresh(): Promise<T | null>;
  clear(): void;
}

export interface ResourceConfig<T> {
  load: () => Promise<T>;
  storageKey: string | null;
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
