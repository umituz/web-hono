/**
 * @umituz/web-hono — the API backend platform for single-Worker apps on
 * Cloudflare (SPA assets + `/api/*` Hono) with Neon Postgres via drizzle.
 *
 * Apps keep their schema (with TABLE_PREFIX), domain routers, zod schemas,
 * and business rules — this package owns the cross-cutting skeleton:
 * the createApi app factory, the error envelope layer, the full-CRUD
 * resource factory, getDb, the uid/pickPatch/stampUpdate/trio/actor
 * helpers, the org-scoped lookups (resolveOrg/orgHasMode/nextNumber),
 * the audit and notification writes, findRow/softDelete, the JSON-404
 * and SPA-fallback handlers, and the ApiEnv binding types.
 *
 * Entry points:
 *   `.`           server core (this file) — includes docStore (jsonb doc factories)
 *   `/types`      Row/NewRow/Serialized/ClientRow — the schema→client type bridge
 *   `/validator`  validateJson — the zod `{ error, details }` body contract
 *   `/client`     apiFetch / apiWrite — the same-origin API client
 *   `/store`      createStore — the fetch-backed reactive store
 *   `/store/react` makeStoreHooks — useQuery/useDbValue/useCollection/useHydration
 *   `/lifecycle`  reset / snapshot / seed — the shared-Neon db lifecycle
 */
export { createApi } from './api';
export type { ApiConfig } from './api';
export { healthRouter } from './health';
export { ApiError, apiOnError } from './errors';
export { crudRoutes, listRoutes } from './crud';
export type { CrudSpec, CrudTable, CrudDb, CrudDbFactory, CreateSpec, ListSpec } from './crud';
export { docStore, canTransition, epoch, WorkflowError, UnknownCollectionError } from './docstore';
export type { Doc, DocTable, DocCollectionSpec, DocStoreSpec } from './docstore';
export { getDb } from './db';
export { uid, pickPatch, patchTypeErrors, normalizeRow, stampUpdate, trio, actor } from './lib';
export { resolveOrg, orgHasMode, nextNumber } from './org';
export type { UsersLike, OrgsLike, NumberedTable } from './org';
export { writeAudit, writeNotification } from './activity';
export type { ActivityTable, AuditWrite, NotificationWrite } from './activity';
export { findRow, softDelete } from './rows';
export type { AliveTable } from './rows';
export { apiNotFound, spaFallback } from './handlers';
export type { ApiEnv } from './env';
