# @umituz/web-hono

The API backend platform for single-Worker apps on Cloudflare (SPA assets + `/api/*` Hono) with Neon Postgres via drizzle. It packages the cross-cutting skeleton proven across the fleet (pilot: [foodora](https://foodora.umituz998.workers.dev)): the `createApi` app factory, the `{ error, details? }` error layer, the full-CRUD resource factory, the schema→client **type bridge**, the same-origin API client, the fetch-backed reactive store (+React hooks), and the shared-Neon database lifecycle scripts.

The package is **source-distributed** (published as raw TypeScript in `src/`). Wrangler, Vite, and tsc all compile it alongside your app; no prebuilt bundle ships.

**1.3 is strictly additive**: every new capability is opt-in — omit the option and you get the exact 1.2 behavior.

## Design philosophy

- **Contract, not framework.** The package owns cross-cutting conventions only — the error envelope, the soft-delete list read, the setting-patch idiom, literal status codes. Your schema, `TABLE_PREFIX`, zod schemas, domain routers, and business rules stay in your app.
- **The factory has a hard scope.** `crudRoutes` covers list + create + setting-patch + soft-delete for PLAIN rows only: "does this request merely change a column value?" Entities with business rules (transitions, restock, overlap guards) stay hand-written in their area router.
- **The schema is the single source of truth.** Client types DERIVE from the drizzle schema (`ClientRow<typeof products>`) — no hand-mirrored interface files that silently drift.
- **Shared-Neon safety.** The lifecycle scripts drop only tables carrying your project's `TABLE_PREFIX` and refuse to run the moment they see a prefix-less table — one Neon project hosts a whole fleet of products.

## The five pillars

| Pillar | What it replaces | Entry |
|---|---|---|
| `createApi({ service, build, routers, middleware })` | the per-app `api/index.ts` skeleton, `routes/health.ts`, hand-mounted 404/SPA handlers | `.` |
| `ApiError` + `apiOnError` | unhandled 500s, inconsistent error bodies; maps zod→400, pg unique→409 | `.` |
| `crudRoutes` with opt-in `create`/`remove` + `?limit&offset&order` | every hand-written POST/DELETE/list-pagination route for plain rows | `.` |
| `Row<T>` / `ClientRow<T>` type bridge | hand-mirrored client interfaces (foodora: 1215 lines) | `/types` |
| store `read`/`view`/`http`/`immutable` + `useCollection`/`useHydration` | repo prologues, tenant-view hand-rolls, boot-gate providers | `/store`, `/store/react` |

## Installation

```bash
npm install @umituz/web-hono
```

Peer dependencies (install alongside): `hono ^4`, `drizzle-orm ^0.45`, `@neondatabase/serverless ^1`, `zod ^4`.

## Quick start

**1. Worker entry** (`api/index.ts`) — the whole skeleton in one call:

```ts
import { createApi } from '@umituz/web-hono';
import { orgRouter } from './routes/org';
import { cateringRouter } from './routes/catering';

export default createApi({
  service: 'foodora-api',
  build: BUILD_MARKER,                     // CI-injected deploy canary
  routers: [['/suppliers', suppliersRouter], ['/', orgRouter]],
  middleware: [/* auth, logging — /api only */],
});
```

The chain: `/api/health` (canary, deliberately before middleware so uptime probes stay open) → your middleware → your routers → `onError` (the envelope) → unmatched `/api/*` stays JSON 404 → everything else resolves via the ASSETS binding (SPA). Hand-mounted apps keep working: `app.onError(apiOnError)` is exported standalone.

**2. Error layer** — throw `ApiError`, get the envelope:

```ts
import { ApiError } from '@umituz/web-hono';

throw ApiError.notFound('Product');          // → 404 { error: 'Product not found' }
throw ApiError.badRequest('Bad input', details); // → 400 { error, details }
```

`apiOnError` maps: `ApiError` → its own status · `ZodError` → `400 { error, details: fieldErrors }` · postgres `23505` unique violation (direct or driver-nested) → `409 { error: 'Already exists' }` · anything else → generic `500` with `console.error` server-side — internals never leak.

**3. Resource factory** (area routers) — plain settings/catalog entities:

```ts
import { crudRoutes } from '@umituz/web-hono';
import { CreateBranchSchema } from '../schemas';

orgRouter.route('/', crudRoutes({
  path: '/branches',
  table: branches,
  label: 'Branch',
  orderBy: { col: branches.name },
  create: { schema: CreateBranchSchema, prefix: 'brn' },  // opt-in POST → 201
  remove: true,                                            // opt-in DELETE → soft-delete
}));
```

Generates:

- `GET /api/branches` — visible rows, ordered; optional `?limit=&offset=&order=name` / `order=-name` (columns whitelisted; limit capped at 500)
- `POST /api/branches` — zod-validated body, server `uid('brn')` id (client ids never land), `defaults(c)` server stamps UNDER the body → `201`
- `PATCH /api/branches/:id` — pickPatch-filtered body, `updatedAt` stamp, `404 'Branch not found'`
- `DELETE /api/branches/:id` — soft delete → `{ ok: true }` / `404`

Omit `create`/`remove` and exactly GET + PATCH register — the 1.x surface. `listRoutes` is the GET-only sibling for append-only collections (event logs, users). `db` is injectable (`db: (c) => myDb`) — the default builds a per-request neon-http instance as before.

**4. Schema helpers + type bridge** — one encoding of the fleet conventions:

```ts
// api/schema.ts
import { trio } from '@umituz/web-hono';
export const branches = pgTable(`${TABLE_PREFIX}branches`, {
  id: text('id').primaryKey(),
  name: text('name'),
  ...trio(), // createdAt/updatedAt/deletedAt timestamptz, fleet-standard
});
```

```ts
// src/domain — client types DERIVE, they don't drift
import type { ClientRow, NewRow } from '@umituz/web-hono/types';
export type Branch = ClientRow<typeof branches>;   // Date→string mapped: the wire shape
export type NewBranch = NewRow<typeof branches>;
```

**5. Validated writes** — the single definition of the body contract:

```ts
import { validator } from 'hono/validator';
import { validateJson } from '@umituz/web-hono/validator';

app.post(
  '/products',
  validator('json', validateJson(CreateProductSchema, 'Invalid product payload')),
  (c) => { /* c.req.valid('json') is the parsed zod output */ },
);
```

Failures answer `400 { error: <message>, details: <fieldErrors> }` — the envelope every client toast surfaces.

**6. Frontend data layer** — the app owns its shape, the package owns the machine:

```ts
// src/data/store.ts — this file IS the app's data layer now
import { createStore } from '@umituz/web-hono/store';

export interface Database { orders: Order[]; loyalty: LoyaltyProgram; /* … */ }

export const store = createStore<Database>({
  endpoints: { orders: '/api/orders', loyalty: '/api/loyalty' },
  empty: (): Database => ({ orders: [], loyalty: EMPTY_LOYALTY }),
  immutable: true, // opt-in: fresh array refs per load — React memo-safe
});

// Repos drop the prologue and the http.ts re-export file:
const findOrder = (id: string) => store.read((db) => db.orders.find((o) => o.id === id));
await store.http.write('/api/orders', { method: 'POST', json: payload }, ['orders']);

// Tenant/derived views stop being hand-rolled:
const activeOrg = store.view(['organizations'], (db) => db.organizations.find((o) => o.id === orgId));
```

```ts
// src/core/hooks.ts — bound to the store (react: optional peer)
import { makeStoreHooks } from '@umituz/web-hono/store/react';

export const { useQuery, useDbValue, useCollection, useHydration } = makeStoreHooks(store);

// App boot gate — replaces hand-rolled hydration providers:
const { status, error, retry } = useHydration();
const orders = useCollection('orders'); // typed, re-renders on its channel
```

The machine: first read hydrates every collection in parallel (deduped, retried on failure); repositories read synchronously via `getDb()` or `store.read(fn)`; writes go through `store.apiWrite(path, init, keys)` / `store.http.write` which refresh only the touched collections on success and leave the cache untouched on failure; per-collection pub/sub (plus the `__refetch_all__` wildcard) drives the hooks; `view(keys, selector)` gives change-detected derived reads.

**7. Lifecycle scripts** (`scripts/`) — keep only your `TABLE_SPECS` registry and thin wrappers:

```ts
// scripts/snapshot.ts
import 'dotenv/config';
import { snapshotToSeed } from '@umituz/web-hono/lifecycle';
import { TABLE_SPECS } from './tables';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required (.env)');
await snapshotToSeed({ specs: TABLE_SPECS, url, outPath: new URL('./seed-data.json.gz', import.meta.url) });
```

`resetTables({ specs, prefix, url })` drops only `prefix*` tables (reverse registry order, CASCADE, safety-stopped); `seedFromSnapshot({ specs, url, inPath })` replays idempotently (ON CONFLICT DO NOTHING, 200-row chunks, per-column-type revival of timestamps/dates).

## Entry points

| Entry point | Exports |
|---|---|
| `@umituz/web-hono` | `createApi`, `ApiConfig`, `healthRouter`, `ApiError`, `apiOnError`, `crudRoutes`, `listRoutes`, `CrudSpec`/`CrudTable`/`CreateSpec`/`ListSpec`/`CrudDb`, `getDb`, `uid`, `pickPatch`, `stampUpdate`, `trio`, `apiNotFound`, `spaFallback`, `ApiEnv` |
| `@umituz/web-hono/types` | `Row<T>`, `NewRow<T>`, `Serialized<T>`, `ClientRow<T>` — type-only |
| `@umituz/web-hono/validator` | `validateJson(schema, message?)` |
| `@umituz/web-hono/client` | `apiFetch<T>`, `apiWrite<T>` (void/204-tolerant) |
| `@umituz/web-hono/store` | `createStore`, `StoreConfig`, `REFETCH_ALL` (+ `read`/`view`/`http`/`subscribeAll`/`snapshot`/`immutable` on the store) |
| `@umituz/web-hono/store/react` | `makeStoreHooks(store)` → `useQuery`, `useDbValue`, `useCollection`, `useHydration`, `QueryResult` |
| `@umituz/web-hono/lifecycle` | `resetTables`, `snapshotToSeed`, `seedFromSnapshot`, `TableSpec`, `SeedSnapshot` |

## Migration notes (per feature, all optional)

- **`createApi`**: delete the hand-mounted skeleton + health route; keep hand-mounting if your chain differs. Adopting the central `onError` intentionally turns some previously-500 paths into 409/400 — flag it in your app's changelog.
- **`create`/`remove` on `crudRoutes`**: plain-row POST/DELETE handlers in area routers delete (~15 lines each); the spec gains two optional keys. Existing GET/PATCH responses are byte-identical.
- **`trio()`**: replace inline time-trio columns with `...trio()` — pure refactor, no SQL change (drizzle-kit sees the same DDL).
- **Type bridge**: migrate interface-by-interface — `type Product = ClientRow<typeof products>`; verify with tsc per folder.
- **`immutable: true`**: one config key; React memo consumers start seeing fresh references. Code that relied on stale references should be deleted alongside adoption.
- **`useHydration`**: delete boot-gate providers; switch on `{ status, error, retry }`.

## What stays in the app

- `api/schema.ts` — every table, the project's `TABLE_PREFIX`, domain columns beyond the trio
- The `Database` interface, `ENDPOINTS` map and empty state of `src/data/store.ts` — that shape IS the app
- Domain routers with business rules (order transitions, reservation overlap guards, restock side effects)
- Zod schemas and per-route error messages
- Audit/notification/entitlement helpers (they insert into YOUR tables)
- Multi-tenant policy (which org the request belongs to — the package stays tenant-agnostic)

## Testing

```bash
npm test
```

73 vitest cases cover the pure logic AND — since 1.3, via in-memory Postgres (PGlite) — the factory's real database behavior: list/soft-delete hiding, `?limit&offset&order`, POST create (uid prefix, defaults-under-body, zod 400s, unique→409), PATCH stamping, DELETE, and the 1.x additivity pins (no `create`/`remove` ⇒ POST/DELETE 404, params-less GET unchanged). Plus: pickPatch/stampUpdate filters, uid shape, the 400/404 envelopes, validator contract, client error mapping and void-endpoint tolerance, reset safety stop, createApi chain (health/middleware/onError/JSON-404-vs-SPA), and the store machine (hydration dedupe/retry, refresh selectivity, pub/sub, view memoization, immutable refs, hooks).

## License

MIT
