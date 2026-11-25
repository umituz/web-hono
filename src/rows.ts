import { and, eq, isNull } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { ApiError } from './errors';
import { stampUpdate } from './lib';
import type { CrudDb, CrudTable } from './crud';

export type IdTable = PgTable & { id: PgColumn };
export type AliveTable = PgTable & { id: PgColumn; deletedAt?: PgColumn };
type RowOf<T> = T extends { $inferSelect: infer R } ? R : never;

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

export async function softDelete<T extends IdTable & { deletedAt: PgColumn }>(
  db: CrudDb,
  table: T,
  id: string,
  label: string,
  extraValues?: Record<string, unknown>,
): Promise<RowOf<T>> {
  const values = { deletedAt: new Date(), ...stampUpdate(table), ...(extraValues ?? {}) };
  const rows = (await db
    .update(table as CrudTable)
    .set(values as never)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning()) as RowOf<T>[];
  const row = rows[0];
  if (!row) throw ApiError.notFound(label);
  return row;
}
