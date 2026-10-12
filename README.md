# @umituz/web-hono

The Hono backend contract for single-Worker apps on Cloudflare (SPA assets + `/api/*` Hono) with Neon Postgres via drizzle. It packages the cross-cutting API skeleton proven in production by the pilot app [foodora](https://foodora.umituz998.workers.dev): the `crudRoutes` factory, `pickPatch`/`uid`, `getDb`, the JSON-404 and SPA-fallback handlers, the zod body-validation contract, the same-origin API client, and the shared-Neon database lifecycle scripts.

The package is **source-distributed** (published as raw TypeScript in `src/`). Wrangler, Vite, and tsc all compile it alongside your app; no prebuilt bundle ships.

## Design philosophy

- **Contract, not framework.** The package owns cross-cutting conventions only — the error envelope (`{ error, details? }`), the soft-delete list read, the setting-patch idiom, literal status codes. Your schema, `TABLE_PREFIX`, zod schemas, domain routers, and business rules stay in your app.
- **The factory has a hard scope.** `crudRoutes` covers list + setting-patch ONLY: "does this PATCH merely change a column value?" Entities with business rules (transitions, restock, overlap guards) stay hand-written in their area router — writing factory-covered code by hand and stuffing out-of-scope behavior into the factory are both contract violations.
- **Store-agnostic client.** `apiFetch`/`apiWrite` never import your store; hosts pass their own typed `refresh` (usually via a 3-line wrapper that binds their collection keys).
- **Shared-Neon safety.** The lifecycle scripts drop only tables carrying your project's `TABLE_PREFIX` and refuse to run the moment they see a prefix-less table — one Neon project hosts a whole fleet of products.

## Installation

```bash
npm install @umituz/web-hono
```

Peer dependencies (install alongside): `hono ^4`, `drizzle-orm ^0.45`, `@neondatabase/serverless ^1`, `zod ^4`.

## Entry points

| Entry point | Exports | Used by |
|---|---|---|
| `@umituz/web-hono` | `crudRoutes`, `CrudSpec`/`CrudTable`, `getDb`, `uid`, `pickPatch`, `apiNotFound`, `spaFallback`, `ApiEnv` | `api/index.ts`, area routers, `api/db.ts` |
| `@umituz/web-hono/validator` | `validateJson(schema, message?)` | every hand-written POST/PATCH route |
| `@umituz/web-hono/client` | `apiFetch<T>`, `apiWrite<T>` | `src/data/http.ts`, repositories |
| `@umituz/web-hono/lifecycle` | `resetTables`, `snapshotToSeed`, `seedFromSnapshot`, `TableSpec`, `SeedSnapshot` | `scripts/reset.ts` / `snapshot.ts` / `seed.ts` wrappers |

## Quick start

**1. Worker entry** (`api/index.ts`) — mount list, then close the chain:

```ts
import { Hono } from 'hono';
import { apiNotFound, spaFallback } from '@umituz/web-hono';
import type { ApiEnv } from '@umituz/web-hono';
import { healthRouter } from './routes/health';
import { orgRouter } from './routes/org';

const app = new Hono<{ Bindings: ApiEnv }>();

app.route('/api/health', healthRouter);
app.route('/api', orgRouter);

app.all('/api/*', apiNotFound); // unmatched API stays JSON — never the SPA's index.html
app.get('*', spaFallback);      // client-side routes resolve via the ASSETS binding

export default app;
```

**2. Factory mounts** (area routers) — plain settings/catalog entities:

```ts
import { crudRoutes } from '@umituz/web-hono';

orgRouter.route('/', crudRoutes({ path: '/branches', table: branches, label: 'Branch', orderBy: { col: branches.name } }));
```

Generates `GET /api/branches` (visible rows, ordered) + `PATCH /api/branches/:id` (pickPatch-filtered body, `updatedAt` stamp, `404 'Branch not found'`).

**3. Validated writes** — the single definition of the body contract:

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

**4. App db wrapper** (`api/db.ts`) — bind your schema once:

```ts
import { getDb } from '@umituz/web-hono';
import * as schema from './schema';

export const getDbBound = (env: { DATABASE_URL: string }) => getDb(env, schema);
```

**5. Frontend client** (`src/data/http.ts`):

```ts
import { apiFetch, apiWrite as write } from '@umituz/web-hono/client';
import { refresh, type CollectionKey } from './store';

export { apiFetch };
export const apiWrite = <T = void>(path: string, init: Parameters<typeof write>[1], keys: CollectionKey[] = []) =>
  write<T>(path, init, keys, (k) => refresh(k));
```

**6. Lifecycle scripts** (`scripts/`) — keep only your `TABLE_SPECS` registry and thin wrappers:

```ts
// scripts/snapshot.ts
import 'dotenv/config';
import { snapshotToSeed } from '@umituz/web-hono/lifecycle';
import { TABLE_SPECS } from './tables';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required (.env)');
await snapshotToSeed({ specs: TABLE_SPECS, url, outPath: new URL('./seed-data.json.gz', import.meta.url) });
```

`resetTables({ specs, prefix, url })` drops only `prefix*` tables (in reverse registry order, CASCADE); `seedFromSnapshot({ specs, url, inPath })` replays idempotently (ON CONFLICT DO NOTHING, 200-row chunks, per-column-type revival of timestamps/dates).

## What stays in the app

- `api/schema.ts` — every table, the project's `TABLE_PREFIX`, fleet column standards (time trio, soft delete, jsonb nesting)
- Domain routers with business rules (order transitions, reservation overlap guards, restock side effects)
- Zod schemas and per-route error messages
- Audit/notification/entitlement helpers (they insert into YOUR tables)
- `api/routes/health.ts` — the `BUILD_MARKER` deploy canary is per-project

## Testing

```bash
npm test
```

21 vitest cases cover the pure logic and DB-free short-circuit paths (pickPatch filters, uid shape, the 400/404 envelopes, validator contract, client error mapping, reset safety stop). Live-DB paths (list/PATCH success, snapshot/seed) are proven by the consuming app's E2E — the pilot is foodora.

## License

MIT
