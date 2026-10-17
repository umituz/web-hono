import { Hono } from 'hono';
import { and, asc, desc, eq, getTableColumns, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import type { Context } from 'hono';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { pickPatch, stampUpdate, uid } from './lib';
import type { ApiEnv } from './env';

/**
 * The standard entity resource factory: GET list (soft-deleted hidden,
 * ordered, optional ?limit/&offset/&order) + PATCH /:id (pickPatch-filtered
 * body, updatedAt stamp, 404 on miss) — plus OPT-IN POST create (zod schema,
 * uid prefix, server-side defaults) and DELETE /:id (soft delete). Mount it
 * onto an area router with `.route('/', crudRoutes({ ... }))`.
 *
 * Omitting `create`/`remove` registers exactly GET + PATCH — the 1.x
 * surface, byte-identical. `db` is injectable (tests, Hyperdrive variants);
 * the default builds a per-request neon-http instance as before.
 *
 * listRoutes is the GET-only sibling for append-only collections (event
 * logs, activities, users) whose rows are written server-side only.
 *
 * Entities with business rules (role immutability guards, goods-receipt
 * restock, order transitions…) stay hand-written in their area router —
 * the factory is for plain settings/catalog rows only.
 */

type RequestContext = Context<{ Bindings: ApiEnv }>;
function defaultDb(c: RequestContext) {
  // Schema-less drizzle: the factory only runs select/insert/update, which
  // never touch the schema registry (only `db.query.*` does) — so it builds
  // its own instance from the request's binding instead of requiring one.
  return drizzle(neon(c.env.DATABASE_URL));
}
export type CrudDb = Pick<NeonHttpDatabase<Record<string, never>>, 'select' | 'insert' | 'update'>;
export type CrudDbFactory = (c: RequestContext) => CrudDb;

export type CrudTable = PgTable & { id: PgColumn; deletedAt: PgColumn };

/** Opt-in POST create: zod-validated body, server-generated uid, optional
 *  request-scoped stamps (organizationId, createdBy…). */
export interface CreateSpec {
  /** zod schema for the request body (`.strict()` per fleet convention). */
  schema: z.ZodType;
  /** uid prefix: 'prd' → prd_<base36 ts><counter>. */
  prefix: string;
  /** Server-side stamps merged UNDER the parsed body — body values win. */
  defaults?: (c: RequestContext) => Record<string, unknown>;
}

export interface ListSpec {
  /** Path under /api, e.g. '/activities'. */
  path: string;
  table: PgTable & { deletedAt: PgColumn };
  /** List order; defaults to insertion order. */
  orderBy?: { col: PgColumn; dir?: 'asc' | 'desc' };
  /** Injectable db factory (tests, Hyperdrive). Default: per-request
   *  drizzle(neon(c.env.DATABASE_URL)) — the 1.x behavior. */
  db?: CrudDbFactory;
}

export interface CrudSpec extends ListSpec {
  table: CrudTable;
  /** Human label for 404s — 'Product' → 'Product not found'. */
  label: string;
  /** Opt-in POST create. Absent ⇒ no POST route (404), as in 1.x. */
  create?: CreateSpec;
  /** Opt-in soft-delete DELETE. Absent ⇒ no DELETE route (404), as in 1.x. */
  remove?: boolean;
}

/** ?limit cap — protects the hydrate-everything thin-read doctrine. */
const MAX_LIST_LIMIT = 500;

/** GET-only list (soft-deleted hidden) for append-only collections — event
 *  logs, activities, users. No PATCH: these rows are written server-side. */
export function listRoutes(spec: ListSpec): Hono<{ Bindings: ApiEnv }> {
  const { path, table, orderBy } = spec;
  const getDb = spec.db ?? defaultDb;
  const router = new Hono<{ Bindings: ApiEnv }>();

  router.get(path, async (c) => {
    const db = getDb(c);
    const q = db.select().from(table).where(isNull(table.deletedAt)).$dynamic();
    if (orderBy) q.orderBy(orderBy.dir === 'desc' ? desc(orderBy.col) : asc(orderBy.col));
    return c.json(await q);
  });

  return router;
}

export function crudRoutes(spec: CrudSpec): Hono<{ Bindings: ApiEnv }> {
  const { path, table, label, orderBy } = spec;
  const getDb = spec.db ?? defaultDb;
  const router = new Hono<{ Bindings: ApiEnv }>();

  router.get(path, async (c) => {
    const db = getDb(c);
    const q = db.select().from(table).where(isNull(table.deletedAt)).$dynamic();

    // ?order=col | -col (leading '-' = desc) — whitelisted against the
    // table's own property columns; an explicit order overrides spec.orderBy.
    const orderParam = c.req.query('order');
    let orderCol: PgColumn | undefined;
    let dir: 'asc' | 'desc' = 'asc';
    if (orderParam !== undefined) {
      const wantDesc = orderParam.startsWith('-');
      const name = orderParam.slice(wantDesc ? 1 : 0);
      const found = (getTableColumns(table) as unknown as Record<string, PgColumn>)[name];
      if (!found) return c.json({ error: 'Invalid order column' }, 400);
      orderCol = found;
      dir = wantDesc ? 'desc' : 'asc';
    } else if (orderBy) {
      orderCol = orderBy.col;
      dir = orderBy.dir ?? 'asc';
    }
    if (orderCol) q.orderBy(dir === 'desc' ? desc(orderCol) : asc(orderCol));

    // ?limit/&offset= — absent params add no clauses: the 1.x query exactly.
    // offset without order follows the spec/default insertion order (the
    // same caveat 1.x lists always had).
    const limitParam = c.req.query('limit');
    if (limitParam !== undefined) {
      const n = Number(limitParam);
      if (!Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) return c.json({ error: 'Invalid limit' }, 400);
      q.limit(n);
    }
    const offsetParam = c.req.query('offset');
    if (offsetParam !== undefined) {
      const n = Number(offsetParam);
      if (!Number.isInteger(n) || n < 0) return c.json({ error: 'Invalid offset' }, 400);
      q.offset(n);
    }

    return c.json(await q);
  });

  router.patch(`${path}/:id`, async (c) => {
    const patch = pickPatch(table, await c.req.json().catch(() => null));
    if (!patch) return c.json({ error: 'No updatable fields' }, 400);
    const db = getDb(c);
    const [row] = await db
      .update(table)
      // Generic tables can't carry per-table set types — values are already
      // column-filtered by pickPatch, so the cast is purely type-level. The
      // updatedAt stamp matches the table's column type (date vs timestamp).
      .set({ ...patch, ...stampUpdate(table) } as never)
      .where(and(eq(table.id, c.req.param('id')), isNull(table.deletedAt)))
      .returning();
    return row ? c.json(row) : c.json({ error: `${label} not found` }, 404);
  });

  if (spec.create) {
    const { schema, prefix, defaults } = spec.create;
    router.post(path, async (c) => {
      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors }, 400);
      }
      const body = parsed.data as Record<string, unknown>;
      const db = getDb(c);
      const [row] = await db
        .insert(table)
        // id LAST: server-generated, never client-supplied. createdAt/
        // updatedAt come from the DB column defaults (fleet convention).
        .values({ ...defaults?.(c), ...body, id: uid(prefix) } as never)
        .returning();
      return c.json(row, 201);
    });
  }

  if (spec.remove) {
    router.delete(`${path}/:id`, async (c) => {
      const db = getDb(c);
      const [row] = await db
        .update(table)
        // Soft delete: every read filters isNull(deletedAt), so the row
        // vanishes from lists without losing history.
        .set({ deletedAt: new Date(), ...stampUpdate(table) } as never)
        .where(and(eq(table.id, c.req.param('id')), isNull(table.deletedAt)))
        .returning({ id: table.id });
      return row ? c.json({ ok: true }) : c.json({ error: `${label} not found` }, 404);
    });
  }

  return router;
}
