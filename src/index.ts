/**
 * @umituz/web-hono — the Hono backend contract for single-Worker apps on
 * Cloudflare (SPA assets + `/api/*` Hono) with Neon Postgres via drizzle:
 * the crudRoutes factory, pickPatch/uid helpers, getDb, the JSON-404 and
 * SPA-fallback handlers, and the ApiEnv binding types.
 *
 * Apps keep their schema (with TABLE_PREFIX), domain routers, zod schemas,
 * and business rules — this package owns the cross-cutting API skeleton
 * only.
 *
 * Entry points:
 *   `.`           server core (this file)
 *   `/validator`  validateJson — the zod `{ error, details }` body contract
 *   `/client`     apiFetch / apiWrite — the same-origin API client
 *   `/lifecycle`  reset / snapshot / seed — the shared-Neon db lifecycle
 */
export { crudRoutes } from './crud';
export type { CrudSpec, CrudTable } from './crud';
export { getDb } from './db';
export { uid, pickPatch } from './lib';
export { apiNotFound, spaFallback } from './handlers';
export type { ApiEnv } from './env';
