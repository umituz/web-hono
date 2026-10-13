import { Hono } from 'hono';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { pickPatch, stampUpdate } from './lib';
import type { ApiEnv } from './env';

/**
 * The standard entity resource: GET list (soft-deleted hidden, ordered) +
 * PATCH /:id (pickPatch-filtered body, updatedAt stamp, 404 on miss).
 * Mount it onto an area router with `.route('/', crudRoutes({ ... }))`.
 *
 * listRoutes is its GET-only sibling for append-only collections (event
 * logs, activities, users) whose rows are written server-side only.
 *
 * Entities with business rules (role immutability guards, goods-receipt
 * restock, order transitions…) stay hand-written in their area router —
 * the factory is for plain settings/catalog rows only.
 */

export type CrudTable = PgTable & { id: PgColumn; deletedAt: PgColumn };

export interface ListSpec {
  /** Path under /api, e.g. '/activities'. */
  path: string;
  table: PgTable & { deletedAt: PgColumn };
  /** List order; defaults to insertion order. */
  orderBy?: { col: PgColumn; dir?: 'asc' | 'desc' };
}

export interface CrudSpec extends ListSpec {
  table: CrudTable;
  /** Human label for 404s — 'Product' → 'Product not found'. */
  label: string;
}

/** GET-only list (soft-deleted hidden) for append-only collections — event
 *  logs, activities, users. No PATCH: these rows are written server-side. */
export function listRoutes(spec: ListSpec): Hono<{ Bindings: ApiEnv }> {
  const { path, table, orderBy } = spec;
  const router = new Hono<{ Bindings: ApiEnv }>();

  router.get(path, async (c) => {
    // Schema-less drizzle: see the note in crudRoutes.
    const db = drizzle(neon(c.env.DATABASE_URL));
    const q = db.select().from(table).where(isNull(table.deletedAt)).$dynamic();
    if (orderBy) q.orderBy(orderBy.dir === 'desc' ? desc(orderBy.col) : asc(orderBy.col));
    return c.json(await q);
  });

  return router;
}

export function crudRoutes(spec: CrudSpec): Hono<{ Bindings: ApiEnv }> {
  const { path, table, label, orderBy } = spec;
  const router = new Hono<{ Bindings: ApiEnv }>();

  router.get(path, async (c) => {
    // Schema-less drizzle: the factory only runs select/update, which never
    // touch the schema registry (only `db.query.*` does) — so it builds its
    // own instance from the request's binding instead of requiring one.
    const db = drizzle(neon(c.env.DATABASE_URL));
    const q = db.select().from(table).where(isNull(table.deletedAt)).$dynamic();
    if (orderBy) q.orderBy(orderBy.dir === 'desc' ? desc(orderBy.col) : asc(orderBy.col));
    return c.json(await q);
  });

  router.patch(`${path}/:id`, async (c) => {
    const patch = pickPatch(table, await c.req.json().catch(() => null));
    if (!patch) return c.json({ error: 'No updatable fields' }, 400);
    const db = drizzle(neon(c.env.DATABASE_URL));
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

  return router;
}
