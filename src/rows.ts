import { and, eq, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { ApiError } from './errors';
import { stampUpdate } from './lib';
import type { CrudDb, CrudTable } from './crud';

export type IdTable = PgTable & { id: PgColumn };
export type AliveTable = PgTable & { id: PgColumn; deletedAt?: PgColumn };
export type OrgScopedTable = AliveTable & {
  organizationId?: PgColumn;
  orgId?: PgColumn;
  tenantId?: PgColumn;
  organization_id?: PgColumn;
  org_id?: PgColumn;
  tenant_id?: PgColumn;
};
export type RowOf<T> = T extends { $inferSelect: infer R } ? R : never;

export interface FindManyByOrgOptions {
  orgColumn?: string;
  limit?: number;
  offset?: number;
  orderBy?: SQL | SQL[];
  where?: SQL;
}

export interface CountOrgRowsOptions {
  orgColumn?: string;
  where?: SQL;
}

export interface PaginateOrgOptions {
  page?: number;
  pageSize?: number;
  orderBy?: SQL | SQL[];
  orgColumn?: string;
  where?: SQL;
}

export interface PaginatedOrgResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function resolveOrgColumnName<T extends IdTable>(table: T, explicit?: string): string {
  if (explicit) return explicit;
  const t = table as unknown as Record<string, unknown>;
  if ('organizationId' in t) return 'organizationId';
  if ('orgId' in t) return 'orgId';
  if ('tenantId' in t) return 'tenantId';
  if ('organization_id' in t) return 'organization_id';
  if ('org_id' in t) return 'org_id';
  if ('tenant_id' in t) return 'tenant_id';
  return 'organizationId';
}

export async function findRow<T extends IdTable>(db: CrudDb, table: T, id: string, label: string): Promise<RowOf<T>> {
  const hasDeletedAt = 'deletedAt' in table && Boolean((table as { deletedAt?: PgColumn }).deletedAt);
  const condition = hasDeletedAt
    ? and(eq(table.id, id), isNull((table as unknown as { deletedAt: PgColumn }).deletedAt))
    : eq(table.id, id);
  const rows = (await db.select().from(table as unknown as CrudTable).where(condition)) as RowOf<T>[];
  const row = rows[0];
  if (!row) throw ApiError.notFound(label);
  return row;
}

export async function findOrgRow<T extends IdTable>(
  db: CrudDb,
  table: T,
  id: string,
  organizationId: string,
  label: string,
  options?: { orgColumn?: string }
): Promise<RowOf<T>> {
  const colName = resolveOrgColumnName(table, options?.orgColumn);
  const orgCol = (table as unknown as Record<string, unknown>)[colName] as PgColumn | undefined;
  if (!orgCol) {
    throw new Error(`Table does not have column "${colName}"`);
  }
  const hasDeletedAt = 'deletedAt' in table && Boolean((table as { deletedAt?: PgColumn }).deletedAt);
  const conditions = [
    eq(table.id, id),
    eq(orgCol, organizationId),
  ];
  if (hasDeletedAt) {
    conditions.push(isNull((table as unknown as { deletedAt: PgColumn }).deletedAt));
  }
  const rows = (await db
    .select()
    .from(table as unknown as CrudTable)
    .where(and(...conditions))) as RowOf<T>[];
  const row = rows[0];
  if (!row) throw ApiError.notFound(label);
  return row;
}

export async function findManyByOrg<T extends IdTable>(
  db: CrudDb,
  table: T,
  organizationId: string,
  options?: FindManyByOrgOptions
): Promise<RowOf<T>[]> {
  const colName = resolveOrgColumnName(table, options?.orgColumn);
  const orgCol = (table as unknown as Record<string, unknown>)[colName] as PgColumn | undefined;
  if (!orgCol) {
    throw new Error(`Table does not have column "${colName}"`);
  }
  const hasDeletedAt = 'deletedAt' in table && Boolean((table as { deletedAt?: PgColumn }).deletedAt);
  const conditions: SQL[] = [eq(orgCol, organizationId)];
  if (hasDeletedAt) {
    conditions.push(isNull((table as unknown as { deletedAt: PgColumn }).deletedAt));
  }
  if (options?.where) {
    conditions.push(options.where);
  }
  const cond = conditions.length === 1 ? conditions[0]! : and(...conditions)!;
  const q = db.select().from(table as unknown as CrudTable).where(cond).$dynamic();
  if (options?.orderBy) {
    const orderings = Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy];
    q.orderBy(...orderings);
  }
  if (options?.limit !== undefined) {
    q.limit(options.limit);
  }
  if (options?.offset !== undefined) {
    q.offset(options.offset);
  }
  return (await q) as RowOf<T>[];
}

export async function countOrgRows<T extends IdTable>(
  db: CrudDb,
  table: T,
  organizationId: string,
  options?: CountOrgRowsOptions
): Promise<number> {
  const colName = resolveOrgColumnName(table, options?.orgColumn);
  const orgCol = (table as unknown as Record<string, unknown>)[colName] as PgColumn | undefined;
  if (!orgCol) {
    throw new Error(`Table does not have column "${colName}"`);
  }
  const hasDeletedAt = 'deletedAt' in table && Boolean((table as { deletedAt?: PgColumn }).deletedAt);
  const conditions: SQL[] = [eq(orgCol, organizationId)];
  if (hasDeletedAt) {
    conditions.push(isNull((table as unknown as { deletedAt: PgColumn }).deletedAt));
  }
  if (options?.where) {
    conditions.push(options.where);
  }
  const cond = conditions.length === 1 ? conditions[0]! : and(...conditions)!;
  const rows = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(table as unknown as CrudTable)
    .where(cond)) as unknown as { count: number | string }[];
  return Number(rows[0]?.count ?? 0);
}

export async function paginateOrgRows<T extends IdTable>(
  db: CrudDb,
  table: T,
  organizationId: string,
  options?: PaginateOrgOptions
): Promise<PaginatedOrgResult<RowOf<T>>> {
  const page = Math.max(1, options?.page ?? 1);
  const pageSize = Math.max(1, Math.min(100, options?.pageSize ?? 20));
  const offset = (page - 1) * pageSize;
  const [items, total] = await Promise.all([
    findManyByOrg(db, table, organizationId, {
      orgColumn: options?.orgColumn,
      limit: pageSize,
      offset,
      orderBy: options?.orderBy,
      where: options?.where,
    }),
    countOrgRows(db, table, organizationId, {
      orgColumn: options?.orgColumn,
      where: options?.where,
    }),
  ]);
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function updateOrgRow<T extends IdTable>(
  db: CrudDb,
  table: T,
  id: string,
  organizationId: string,
  values: Record<string, unknown>,
  label: string,
  options?: { orgColumn?: string }
): Promise<RowOf<T>> {
  const colName = resolveOrgColumnName(table, options?.orgColumn);
  const orgCol = (table as unknown as Record<string, unknown>)[colName] as PgColumn | undefined;
  if (!orgCol) {
    throw new Error(`Table does not have column "${colName}"`);
  }
  const hasDeletedAt = 'deletedAt' in table && Boolean((table as { deletedAt?: PgColumn }).deletedAt);
  const conditions = [
    eq(table.id, id),
    eq(orgCol, organizationId),
  ];
  if (hasDeletedAt) {
    conditions.push(isNull((table as unknown as { deletedAt: PgColumn }).deletedAt));
  }
  const patch = { ...values, ...stampUpdate(table) };
  const rows = (await db
    .update(table as unknown as CrudTable)
    .set(patch as never)
    .where(and(...conditions))
    .returning()) as RowOf<T>[];
  const row = rows[0];
  if (!row) throw ApiError.notFound(label);
  return row;
}

export async function softDelete<T extends IdTable & { deletedAt: PgColumn }>(
  db: CrudDb,
  table: T,
  id: string,
  label: string,
  extraValues?: Record<string, unknown>,
): Promise<RowOf<T>> {
  const values = { deletedAt: new Date(), ...stampUpdate(table), ...(extraValues ?? {}) };
  const rows = (await db
    .update(table as unknown as CrudTable)
    .set(values as never)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning()) as RowOf<T>[];
  const row = rows[0];
  if (!row) throw ApiError.notFound(label);
  return row;
}

export async function softDeleteOrgRow<T extends IdTable & { deletedAt: PgColumn }>(
  db: CrudDb,
  table: T,
  id: string,
  organizationId: string,
  label: string,
  extraValues?: Record<string, unknown>,
  options?: { orgColumn?: string }
): Promise<RowOf<T>> {
  const colName = resolveOrgColumnName(table, options?.orgColumn);
  const orgCol = (table as unknown as Record<string, unknown>)[colName] as PgColumn | undefined;
  if (!orgCol) {
    throw new Error(`Table does not have column "${colName}"`);
  }
  const values = { deletedAt: new Date(), ...stampUpdate(table), ...(extraValues ?? {}) };
  const rows = (await db
    .update(table as unknown as CrudTable)
    .set(values as never)
    .where(and(eq(table.id, id), eq(orgCol, organizationId), isNull(table.deletedAt)))
    .returning()) as RowOf<T>[];
  const row = rows[0];
  if (!row) throw ApiError.notFound(label);
  return row;
}

export async function deleteOrgRow<T extends IdTable>(
  db: CrudDb,
  table: T,
  id: string,
  organizationId: string,
  label: string,
  options?: { orgColumn?: string }
): Promise<RowOf<T>> {
  const colName = resolveOrgColumnName(table, options?.orgColumn);
  const orgCol = (table as unknown as Record<string, unknown>)[colName] as PgColumn | undefined;
  if (!orgCol) {
    throw new Error(`Table does not have column "${colName}"`);
  }
  const rows = (await db
    .delete(table as unknown as CrudTable)
    .where(and(eq(table.id, id), eq(orgCol, organizationId)))
    .returning()) as RowOf<T>[];
  const row = rows[0];
  if (!row) throw ApiError.notFound(label);
  return row;
}
