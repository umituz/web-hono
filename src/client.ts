export class ApiClientError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly details?: unknown;
  readonly conflicts?: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.body = body;
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if ('details' in rec) this.details = rec.details;
      if ('conflicts' in rec) this.conflicts = rec.conflicts;
    }
  }
}

export async function apiFetch<T>(path: string, init: { method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; json?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: init.json !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiClientError(body?.error ?? `API ${path} responded ${res.status}`, res.status, body);
  }
  const text = await res.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

export async function apiWrite<T = void>(
  path: string,
  init: { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; json?: unknown },
  keys: string[] = [],
  refresh: (keys: string[]) => Promise<void> = async () => {},
): Promise<T> {
  const result = await apiFetch<T>(path, init);
  if (keys.length) await refresh(keys);
  return result;
}
