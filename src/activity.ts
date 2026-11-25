import { eq, getTableColumns } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { uid } from './lib';
import type { CrudDb } from './crud';
import type { ApiErrorSink } from './api';
import type { ApiEnv } from './env';

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

function timeStamp(table: ActivityTable, candidates: string[]): Record<string, Date | string> {
  let columns: Columns | undefined;
  try {
    columns = getTableColumns(table) as unknown as Columns;
  } catch {
    columns = undefined;
  }
  if (!columns || typeof columns !== 'object') {
    return { at: new Date().toISOString() };
  }
  for (const name of candidates) {
    const meta = columns[name];
    if (!meta) continue;
    const kind = meta.columnType ?? '';
    return { [name]: kind.includes('Text') || kind.includes('Varchar') ? new Date().toISOString() : new Date() };
  }
  return {};
}

function boolStamp(table: ActivityTable, name: string, value: boolean): Record<string, boolean> {
  let columns: Columns | undefined;
  try {
    columns = getTableColumns(table) as unknown as Columns;
  } catch {
    columns = undefined;
  }
  if (!columns || typeof columns !== 'object') return {};
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

export interface DiffOptions {
  exclude?: string[];
  keys?: string[];
}

const DEFAULT_EXCLUDED_DIFF_KEYS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'password',
  'secret',
  'token',
]);

export function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  options: DiffOptions = {},
): { field: string; from: string; to: string }[] {
  const excluded = options.exclude ? new Set([...DEFAULT_EXCLUDED_DIFF_KEYS, ...options.exclude]) : DEFAULT_EXCLUDED_DIFF_KEYS;
  const targetKeys = options.keys ?? Object.keys(after);
  const changes: { field: string; from: string; to: string }[] = [];
  for (const field of targetKeys) {
    if (excluded.has(field)) continue;
    const fromVal = before[field];
    const toVal = after[field];
    if (fromVal === toVal) continue;
    if (typeof fromVal === 'object' && typeof toVal === 'object' && JSON.stringify(fromVal) === JSON.stringify(toVal)) {
      continue;
    }
    changes.push({
      field,
      from: fromVal === undefined || fromVal === null ? '' : typeof fromVal === 'object' ? JSON.stringify(fromVal) : String(fromVal),
      to: toVal === undefined || toVal === null ? '' : typeof toVal === 'object' ? JSON.stringify(toVal) : String(toVal),
    });
  }
  return changes;
}

export async function auditAction(
  db: CrudDb,
  table: ActivityTable,
  actor: { actorId: string; actorName: string },
  action: string,
  entity: { type: string; id: string; label: string },
  before?: Record<string, unknown>,
  after?: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Promise<void> {
  const changes = before && after ? diffChanges(before, after) : undefined;
  await writeAudit(db, table, {
    actorId: actor.actorId,
    actorName: actor.actorName,
    action,
    entityType: entity.type,
    entityId: entity.id,
    entityLabel: entity.label,
    changes,
    ...extra,
  });
}

export interface ErrorLogWrite {
  method: string;
  path: string;
  status: number;
  message: string;
  stack?: string | null;
  [extra: string]: unknown;
}

export async function writeErrorLog(
  db: CrudDb,
  table: ActivityTable,
  entry: ErrorLogWrite,
  prefix = 'err',
): Promise<void> {
  let columns: Columns | undefined;
  try {
    columns = getTableColumns(table) as unknown as Columns;
  } catch {
    columns = undefined;
  }
  const payload: Record<string, unknown> = {
    id: uid(prefix),
    ...timeStamp(table, ['at', 'createdAt']),
    method: entry.method,
    status: entry.status,
    message: entry.message,
  };
  if (columns && 'route' in columns) {
    payload.route = entry.path;
  }
  if (!columns || 'path' in columns) {
    payload.path = entry.path;
  }
  if (entry.stack && (!columns || 'stack' in columns)) {
    payload.stack = entry.stack;
  }
  await db.insert(table).values(payload as never);
}

export function createErrorLogSink<E extends ApiEnv = ApiEnv>(
  dbFactory: (env: E) => CrudDb,
  table: ActivityTable,
  prefix = 'err',
): ApiErrorSink<E> {
  return async (info, env) => {
    if (info.status < 500) return;
    try {
      const db = dbFactory(env);
      const error = info.error instanceof Error ? info.error : undefined;
      await writeErrorLog(
        db,
        table,
        {
          method: info.method,
          path: info.path,
          status: info.status,
          message: info.message,
          stack: error?.stack,
        },
        prefix,
      );
    } catch {}
  };
}
