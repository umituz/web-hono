import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { matchesEtag } from './etag';

/** Cache-Control catalog for auth-private responses. */
export const CACHE_CONTROLS = {
  /** Revalidate every time (audio/video streams, mutable payloads). */
  privateRevalidate: 'private, max-age=0, must-revalidate',
  /** Browser-fresh for a day (cover art and other immutable-ish assets). */
  privateDay: 'private, max-age=86400',
  /** ETag-carried payloads: cache allowed, revalidate on every use. */
  etagRevalidate: 'no-cache',
} as const;

export interface RequestScopeConfig {
  /** Query parameter that carries the scope explicitly (`?lang=ko`). */
  queryParam: string;
  /** Cookie consulted when the query parameter is absent. */
  cookieKey: string;
}

/**
 * Resolve a request-scoped value — a language, a tenant, a workspace —
 * from the explicit query parameter first, then the ambient cookie, or
 * null when the request carries neither. Routes answer a 400 on null
 * instead of guessing a default.
 */
export function requestScopeOf(c: Context, config: RequestScopeConfig): string | null {
  const fromQuery = c.req.query(config.queryParam);
  if (fromQuery !== undefined && fromQuery.length > 0) return fromQuery;
  const fromCookie = getCookie(c, config.cookieKey);
  if (fromCookie !== undefined && fromCookie.length > 0) return fromCookie;
  return null;
}

/**
 * The If-None-Match dance in one call: weak-compares the request's
 * If-None-Match against `etag` and answers 304 (ETag + no-cache headers,
 * empty body) or 200 (same headers plus the JSON payload). Payload types
 * stay the caller's — only the transport is shared.
 */
export function respondWithEtag(c: Context, etag: string, payload: unknown) {
  if (matchesEtag(c.req.header('If-None-Match'), etag)) {
    return c.body(null, 304, { ETag: etag, 'Cache-Control': CACHE_CONTROLS.etagRevalidate });
  }
  c.header('ETag', etag);
  c.header('Cache-Control', CACHE_CONTROLS.etagRevalidate);
  return c.json(payload);
}

/**
 * `500 { error, details }` for caught errors in hand-rolled routes —
 * the envelope's last resort outside the global onError.
 */
export function internalError(c: Context, message: string, err?: unknown) {
  return c.json(
    {
      error: message,
      details: err instanceof Error ? err.name : 'error',
    },
    500,
  );
}
