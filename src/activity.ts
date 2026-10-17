import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { uid } from './lib';
import type { CrudDb } from './crud';

/**
 * Audit-log and notification writes — the server-side activity pair the
 * fleet hand-copied into api/lib.ts (63 projects carried a recordAudit
 * twin at audit time, 21 a pushNotification twin). The entry spreads
 * as-is, so app-specific columns (branchId, tenantId, summary…) pass
 * through untouched; only id/at/changes (id/at/read) are server-stamped.
 * Bind once in api/lib.ts with your tables and entry types.
 */

/** Append-only activity table shape (audit log, notifications). */
export type ActivityTable = PgTable & { id: PgColumn };

/** Audit row — the fleet-standard fields plus any app extras. */
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

/** Notification row — the fleet-standard fields plus any app extras. */
export interface NotificationWrite {
  type: string;
  severity: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  [extra: string]: unknown;
}

/** Append an audit row (server stamps id, at, changes default). */
export async function writeAudit(db: CrudDb, table: ActivityTable, entry: AuditWrite, prefix = 'aud'): Promise<void> {
  await db.insert(table).values({ id: uid(prefix), at: new Date(), changes: entry.changes ?? [], ...entry } as never);
}

/** Append a notification row (server stamps id, at, unread default). */
export async function writeNotification(
  db: CrudDb,
  table: ActivityTable,
  n: NotificationWrite,
  prefix = 'ntf',
): Promise<void> {
  await db.insert(table).values({ id: uid(prefix), at: new Date(), read: false, ...n } as never);
}
