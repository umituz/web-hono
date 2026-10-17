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
  severity: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  [extra: string]: unknown;
}

export async function writeAudit(db: CrudDb, table: ActivityTable, entry: AuditWrite, prefix = 'aud'): Promise<void> {
  await db.insert(table).values({ id: uid(prefix), at: new Date(), changes: entry.changes ?? [], ...entry } as never);
}

export async function writeNotification(
  db: CrudDb,
  table: ActivityTable,
  n: NotificationWrite,
  prefix = 'ntf',
): Promise<void> {
  await db.insert(table).values({ id: uid(prefix), at: new Date(), read: false, ...n } as never);
}
