/* Minimal JSON client for a same-origin Hono API. Throws an Error carrying
   the server's message (zod/404/400 bodies are `{ error }`) so UI toast
   handlers can surface it directly. */

export async function apiFetch<T>(path: string, init: { method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; json?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: init.json !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `API ${path} responded ${res.status}`);
  }
  // Void endpoints (204 / empty body) resolve to undefined — res.json()
  // would throw a SyntaxError on the empty stream.
  const text = await res.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

/**
 * The repository write idiom in one call: mutate through the API, then
 * refresh the collections the write touched. Refresh only runs when the
 * write succeeded — failures leave the cache untouched.
 *
 * Hosts with a store/cache layer pass their own `refresh` (and usually wrap
 * this in a typed helper binding their collection keys); `keys` stay plain
 * strings here so the package stays store-agnostic.
 */
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
