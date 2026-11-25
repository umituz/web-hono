import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
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

export function clientIpOf(c: Context): string {
  const headers = c.req.raw.headers;
  const cfIp = headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim();
  const xForwarded = headers.get('x-forwarded-for');
  if (xForwarded) return xForwarded.split(',')[0]!.trim();
  const xReal = headers.get('x-real-ip');
  if (xReal) return xReal.trim();
  return '127.0.0.1';
}

export function ok(c: Context, data: unknown, status: ContentfulStatusCode = 200) {
  return c.json(data, status);
}

export function created(c: Context, data: unknown) {
  return c.json(data, 201);
}

export function noContent(c: Context) {
  return c.body(null, 204);
}

export function badRequest(c: Context, message = 'Bad request', details?: unknown) {
  return c.json(details !== undefined ? { error: message, details } : { error: message }, 400);
}

export function unauthorized(c: Context, message = 'Unauthorized') {
  return c.json({ error: message }, 401);
}

export function forbidden(c: Context, message = 'Forbidden') {
  return c.json({ error: message }, 403);
}

export function notFound(c: Context, label = 'Resource') {
  return c.json({ error: `${label} not found` }, 404);
}

export function conflict(c: Context, message = 'Already exists') {
  return c.json({ error: message }, 409);
}

export function unprocessable(c: Context, message = 'Unprocessable entity', details?: unknown) {
  return c.json(details !== undefined ? { error: message, details } : { error: message }, 422);
}

export function tooManyRequests(c: Context, message = 'Too many requests', retryAfterSeconds?: number) {
  if (typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0) {
    c.header('Retry-After', String(Math.ceil(retryAfterSeconds)));
  }
  return c.json({ error: message }, 429);
}

export function gone(c: Context, message = 'Resource gone') {
  return c.json({ error: message }, 410);
}

export function payloadTooLarge(c: Context, message = 'Payload too large') {
  return c.json({ error: message }, 413);
}

export function success(c: Context, extra?: Record<string, unknown>, status: ContentfulStatusCode = 200) {
  return c.json({ success: true, ...(extra ?? {}) }, status);
}

export function extractBearerToken(c: Context): string | null {
  const header = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match && match[1] ? match[1].trim() : null;
}

export interface ParsePaginationOptions {
  defaultPageSize?: number;
  maxPageSize?: number;
}

export function parsePagination(c: Context, options: ParsePaginationOptions = {}) {
  const defaultSize = options.defaultPageSize ?? 20;
  const maxSize = options.maxPageSize ?? 100;
  const rawPage = Number(c.req.query('page'));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawSize = Number(c.req.query('pageSize') ?? c.req.query('limit'));
  const pageSize = Number.isInteger(rawSize) && rawSize > 0 ? Math.min(rawSize, maxSize) : defaultSize;
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset, limit: pageSize };
}

export function queryString(c: Context, key: string, defaultValue = ''): string {
  const value = c.req.query(key);
  return typeof value === 'string' ? value.trim() : defaultValue;
}

export function queryInt(
  c: Context,
  key: string,
  defaultValue?: number,
  options?: { min?: number; max?: number },
): number | undefined {
  const raw = c.req.query(key);
  if (raw === undefined || raw === null || raw.trim() === '') return defaultValue;
  const num = Number(raw);
  if (!Number.isInteger(num)) return defaultValue;
  if (options?.min !== undefined && num < options.min) return options.min;
  if (options?.max !== undefined && num > options.max) return options.max;
  return num;
}

export function queryNumber(c: Context, key: string, defaultValue?: number): number | undefined {
  const raw = c.req.query(key);
  if (raw === undefined || raw === null || raw.trim() === '') return defaultValue;
  const num = Number(raw);
  return Number.isFinite(num) ? num : defaultValue;
}

export function queryBoolean(c: Context, key: string, defaultValue = false): boolean {
  const raw = c.req.query(key);
  if (raw === undefined || raw === null) return defaultValue;
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return defaultValue;
}

export function queryArray(c: Context, key: string, delimiter = ','): string[] {
  const raw = c.req.query(key);
  if (raw === undefined || raw === null || raw.trim() === '') return [];
  return raw
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function paramInt(c: Context, key: string, defaultValue?: number): number | undefined {
  const raw = c.req.param(key);
  if (raw === undefined || raw === null || raw.trim() === '') return defaultValue;
  const num = Number(raw);
  return Number.isInteger(num) ? num : defaultValue;
}
