import { Hono } from 'hono';
import { and, asc, desc, eq, getTableColumns, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import type { Context } from 'hono';
import type { SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { normalizeRow, patchTypeErrors, pickPatch, stampUpdate, uid } from './lib';
import type { ApiEnv } from './env';

type RequestContext = Context<{ Bindings: ApiEnv }>;
function defaultDb(c: RequestContext) {
  return drizzle(neon(c.env.DATABASE_URL));
}
export type CrudDb = Pick<NeonHttpDatabase<Record<string, never>>, 'select' | 'insert' | 'update'> & {
  batch?: NeonHttpDatabase<Record<string, never>>['batch'];
};
export type CrudDbFactory = (c: RequestContext) => CrudDb;

export type CrudTable = PgTable & { id: PgColumn; deletedAt: PgColumn };

export type OrderSpec = { col: PgColumn; dir?: 'asc' | 'desc' };

export interface CreateSpec {
  schema: z.ZodType;
  prefix: string;
  defaults?: (c: RequestContext) => Record<string, unknown>;
  pre?: (c: RequestContext, body: Record<string, unknown>) => Promise<Response | void>;
}

export interface OrgScopeSpec {
  column?: PgColumn;
  farmColumn?: PgColumn;
  farms?: PgTable & { id: PgColumn; orgId: PgColumn };
  resolve: (c: RequestContext) => Promise<string | null | undefined>;
}

export interface ListSpec {
  path: string;
  table: PgTable & { deletedAt: PgColumn };
  orderBy?: OrderSpec | ReadonlyArray<OrderSpec>;
  db?: CrudDbFactory;
  orgScope?: OrgScopeSpec;
}

export interface CrudSpec extends ListSpec {
  table: CrudTable;
  label: string;
  create?: CreateSpec;
  remove?: boolean;
}

const MAX_LIST_LIMIT = 500;

function assertOrgScope(scope: OrgScopeSpec): void {
  if (scope.column && scope.farmColumn) throw new Error('orgScope: pass either column or farmColumn, not both');
  if (!scope.column && !scope.farmColumn) throw new Error('orgScope: column or farmColumn is required');
  if (scope.farmColumn && !scope.farms) throw new Error('orgScope: farms table is required with farmColumn');
}

function orgScopeCondition(scope: OrgScopeSpec, db: CrudDb, orgId: string): SQL {
  if (scope.column) return eq(scope.column, orgId) as SQL;
  const farms = scope.farms!;
  return inArray(scope.farmColumn!, db.select({ id: farms.id }).from(farms).where(eq(farms.orgId, orgId))) as SQL;
}

async function resolveScopedOrg(spec: ListSpec, c: RequestContext): Promise<string | null | undefined> {
  if (spec.orgScope) assertOrgScope(spec.orgScope);
  return spec.orgScope?.resolve(c);
}

function orgColumnKey(spec: ListSpec, column: PgColumn): string | undefined {
  const cols = getTableColumns(spec.table) as unknown as Record<string, PgColumn>;
  return Object.keys(cols).find((k) => cols[k] === column);
}

export function listRoutes(spec: ListSpec): Hono<{ Bindings: ApiEnv }> {
  const { path, table, orderBy } = spec;
  const getDb = spec.db ?? defaultDb;
  const router = new Hono<{ Bindings: ApiEnv }>();

  router.get(path, async (c) => {
    const db = getDb(c);
    const conds: SQL[] = [isNull(table.deletedAt) as SQL];
    if (spec.orgScope) {
      const orgId = await resolveScopedOrg(spec, c);
      if (!orgId) return c.json({ error: 'Sign in to an organization to list this resource' }, 401);
      conds.push(orgScopeCondition(spec.orgScope, db, orgId));
    }
    const q = db.select().from(table).where(conds.length === 1 ? conds[0] : and(...conds)).$dynamic();
    const orders = orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy];
    if (orders.length > 0) q.orderBy(...orders.map((o) => (o.dir === 'desc' ? desc(o.col) : asc(o.col))));
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
    const conds: SQL[] = [isNull(table.deletedAt) as SQL];
    if (spec.orgScope) {
      const orgId = await resolveScopedOrg(spec, c);
      if (!orgId) return c.json({ error: 'Sign in to an organization to list this resource' }, 401);
      conds.push(orgScopeCondition(spec.orgScope, db, orgId));
    }
    const q = db.select().from(table).where(conds.length === 1 ? conds[0] : and(...conds)).$dynamic();

    const orderParam = c.req.query('order');
    if (orderParam !== undefined) {
      const wantDesc = orderParam.startsWith('-');
      const name = orderParam.slice(wantDesc ? 1 : 0);
      const found = (getTableColumns(table) as unknown as Record<string, PgColumn>)[name];
      if (!found) return c.json({ error: 'Invalid order column' }, 400);
      q.orderBy(wantDesc ? desc(found) : asc(found));
    } else if (orderBy) {
      const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
      q.orderBy(...orders.map((o) => (o.dir === 'desc' ? desc(o.col) : asc(o.col))));
    }

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
    const raw = await c.req.json().catch(() => undefined);
    if (raw === undefined) return c.json({ error: 'Malformed JSON in request body' }, 400);
    const patch = pickPatch(table, raw);
    if (!patch) return c.json({ error: 'No updatable fields' }, 400);
    const typeDetails = patchTypeErrors(table, patch);
    if (typeDetails) return c.json({ error: 'Invalid field types', details: typeDetails }, 400);
    const db = getDb(c);
    const conds: SQL[] = [eq(table.id, c.req.param('id')), isNull(table.deletedAt) as SQL];
    if (spec.orgScope) {
      const orgId = await resolveScopedOrg(spec, c);
      if (!orgId) return c.json({ error: 'Sign in to an organization to update this resource' }, 401);
      conds.push(orgScopeCondition(spec.orgScope, db, orgId));
    }
    const [row] = await db
      .update(table)
      .set({ ...patch, ...stampUpdate(table) } as never)
      .where(conds.length === 1 ? conds[0] : and(...conds))
      .returning();
    return row ? c.json(row) : c.json({ error: `${label} not found` }, 404);
  });

  if (spec.create) {
    const { schema, prefix, defaults, pre } = spec.create;
    router.post(path, async (c) => {
      const raw = await c.req.json().catch(() => undefined);
      if (raw === undefined || typeof raw !== 'object' || raw === null) {
        return c.json({ error: 'Malformed JSON in request body' }, 400);
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors }, 400);
      }
      const body = normalizeRow(table, parsed.data as Record<string, unknown>);
      if (pre) {
        const gate = await pre(c, body);
        if (gate) return gate;
      }
      const db = getDb(c);
      const stamped: Record<string, unknown> = {};
      if (spec.orgScope) {
        const orgId = await resolveScopedOrg(spec, c);
        if (!orgId) return c.json({ error: 'Sign in to an organization to create this resource' }, 401);
        const scope = spec.orgScope;
        if (scope.column) {
          const key = orgColumnKey(spec, scope.column);
          if (key) stamped[key] = orgId;
        } else {
          const key = orgColumnKey(spec, scope.farmColumn!);
          const farmId = key ? (body[key] as string | undefined) : undefined;
          if (farmId) {
            const farms = scope.farms!;
            const [farm] = await db
              .select({ id: farms.id })
              .from(farms)
              .where(and(eq(farms.id, farmId), eq(farms.orgId, orgId)))
              .limit(1);
            if (!farm) return c.json({ error: 'Farm is not in your organization' }, 400);
          }
        }
      }
      const [row] = await db
        .insert(table)
        .values({ ...defaults?.(c), ...body, ...stamped, id: uid(prefix) } as never)
        .returning();
      return c.json(row, 201);
    });
  }

  if (spec.remove) {
    router.delete(`${path}/:id`, async (c) => {
      const db = getDb(c);
      const conds: SQL[] = [eq(table.id, c.req.param('id')), isNull(table.deletedAt) as SQL];
      if (spec.orgScope) {
        const orgId = await resolveScopedOrg(spec, c);
        if (!orgId) return c.json({ error: 'Sign in to an organization to delete this resource' }, 401);
        conds.push(orgScopeCondition(spec.orgScope, db, orgId));
      }
      const [row] = await db
        .update(table)
        .set({ deletedAt: new Date(), ...stampUpdate(table) } as never)
        .where(conds.length === 1 ? conds[0] : and(...conds))
        .returning({ id: table.id });
      return row ? c.json({ ok: true }) : c.json({ error: `${label} not found` }, 404);
    });
  }

  return router;
}
