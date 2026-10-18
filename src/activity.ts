import { eq, getTableColumns } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { uid } from './lib';
import type { CrudDb } from './crud';

export type ActivityTable = PgTable & { id: PgColumn };

export interface AuditWrite {
  actorId: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  changes?: { field: string; from: string; to: string }[];
  [extra: string]: unknown;
}

export interface NotificationWrite {
  type?: string;
  severity?: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  [extra: string]: unknown;
}

export interface NotificationOpts {
  prefix?: string;
  dedupe?: { column: PgColumn; value: unknown };
}

type ColumnMeta = { columnType?: string };
type Columns = Record<string, ColumnMeta>;

/** Stamps the first present time column — the fleet's `at` plain tables and
 *  the trio-convention (`createdAt`) tables are both served; tables with
 *  neither rely on their column defaults. Text time columns receive the ISO
 *  string form, timestamp columns the Date object. */
function timeStamp(table: ActivityTable, candidates: string[]): Record<string, Date | string> {
  const columns = getTableColumns(table) as unknown as Columns;
  for (const name of candidates) {
    const meta = columns[name];
    if (!meta) continue;
    const kind = meta.columnType ?? '';
    return { [name]: kind.includes('Text') || kind.includes('Varchar') ? new Date().toISOString() : new Date() };
  }
  return {};
}

function boolStamp(table: ActivityTable, name: string, value: boolean): Record<string, boolean> {
  const columns = getTableColumns(table) as unknown as Columns;
  return columns[name] ? { [name]: value } : {};
}

export async function writeAudit(db: CrudDb, table: ActivityTable, entry: AuditWrite, prefix = 'aud'): Promise<void> {
  await db.insert(table).values({ id: uid(prefix), ...timeStamp(table, ['at', 'createdAt']), changes: entry.changes ?? [], ...entry } as never);
}

export async function writeNotification(
  db: CrudDb,
  table: ActivityTable,
  n: NotificationWrite,
  opts: string | NotificationOpts = {},
): Promise<boolean> {
  const o = typeof opts === 'string' ? { prefix: opts } : opts;
  if (o.dedupe) {
    const [dupe] = await db.select({ id: table.id }).from(table).where(eq(o.dedupe.column, o.dedupe.value)).limit(1);
    if (dupe) return false;
  }
  await db.insert(table).values({ id: uid(o.prefix ?? 'ntf'), ...timeStamp(table, ['at', 'createdAt']), ...boolStamp(table, 'read', false), ...n } as never);
  return true;
}
