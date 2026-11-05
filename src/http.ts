import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { matchesEtag } from './etag';

export const CACHE_CONTROLS = {
  privateRevalidate: 'private, max-age=0, must-revalidate',
  privateDay: 'private, max-age=86400',
  etagRevalidate: 'no-cache',
} as const;

export interface RequestScopeConfig {
  queryParam: string;
  cookieKey: string;
}

export function requestScopeOf(c: Context, config: RequestScopeConfig): string | null {
  const fromQuery = c.req.query(config.queryParam);
  if (fromQuery !== undefined && fromQuery.length > 0) return fromQuery;
  const fromCookie = getCookie(c, config.cookieKey);
  if (fromCookie !== undefined && fromCookie.length > 0) return fromCookie;
  return null;
}

export function notModifiedResponse(c: Context, etag: string): Response | null {
  if (!matchesEtag(c.req.header('If-None-Match'), etag)) return null;
  return c.body(null, 304, { ETag: etag, 'Cache-Control': CACHE_CONTROLS.etagRevalidate });
}

export function respondWithEtag(c: Context, etag: string, payload: unknown) {
  const notModified = notModifiedResponse(c, etag);
  if (notModified) return notModified;
  c.header('ETag', etag);
  c.header('Cache-Control', CACHE_CONTROLS.etagRevalidate);
  return c.json(payload);
}

export function internalError(c: Context, message: string, err?: unknown) {
  return c.json(
    {
      error: message,
      details: err instanceof Error ? err.name : 'error',
    },
    500,
  );
}
