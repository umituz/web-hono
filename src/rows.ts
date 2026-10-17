import { and, eq, isNull } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { ApiError } from './errors';
import { stampUpdate } from './lib';
import type { CrudDb, CrudTable } from './crud';

export type AliveTable = PgTable & { id: PgColumn; deletedAt: PgColumn };
type RowOf<T> = T extends { $inferSelect: infer R } ? R : never;

/** Live row by id — a miss throws ApiError.notFound (the envelope's 404). */
export async function findRow<T extends AliveTable>(db: CrudDb, table: T, id: string, label: string): Promise<RowOf<T>> {
  const rows = (await db.select().from(table as CrudTable).where(and(eq(table.id, id), isNull(table.deletedAt)))) as RowOf<T>[];
  const row = rows[0];
  if (!row) throw ApiError.notFound(label);
  return row;
}

/** Soft delete (deletedAt + updatedAt stamps) — a miss throws notFound. */
export async function softDelete<T extends AliveTable>(db: CrudDb, table: T, id: string, label: string): Promise<RowOf<T>> {
  const rows = (await db
    .update(table as CrudTable)
    .set({ deletedAt: new Date(), ...stampUpdate(table) } as never)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning()) as RowOf<T>[];
  const row = rows[0];
  if (!row) throw ApiError.notFound(label);
  return row;
}
