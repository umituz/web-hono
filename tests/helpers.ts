import { pgTable, text, timestamp, integer, date, jsonb, boolean, bigint } from 'drizzle-orm/pg-core';

/** Test-only app table: id/text/int/timestamptz/date columns so every
 * column-type branch (pickPatch coercion, seed revive) is reachable. */
export const widgets = pgTable('wh_widgets', {
  id: text('id').primaryKey(),
  name: text('name'),
  count: integer('count'),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  bestBefore: date('best_before'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

/** Date-string-stamped table: updatedAt is a calendar
 *  date column, so the update stamp must be a 'YYYY-MM-DD' string. */
export const journals = pgTable('wh_journals', {
  id: text('id').primaryKey(),
  note: text('note'),
  createdAt: date('created_at', { mode: 'string' }).notNull(),
  updatedAt: date('updated_at', { mode: 'string' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

/** Org/activity fixtures (org.ts + activity.ts coverage): users/orgs with
 *  the fleet shapes, org-scoped numbered documents, and one append-only
 *  activity table serving both audit and notification writes. */
export const orgUsers = pgTable('wh_org_users', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const orgs = pgTable('wh_orgs', {
  id: text('id').primaryKey(),
  modes: jsonb('modes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const documents = pgTable('wh_documents', {
  id: text('id').primaryKey(),
  number: text('number'),
  organizationId: text('organization_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const activities = pgTable('wh_activities', {
  id: text('id').primaryKey(),
  at: timestamp('at', { withTimezone: true }),
  actorId: text('actor_id'),
  actorName: text('actor_name'),
  action: text('action'),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  entityLabel: text('entity_label'),
  changes: jsonb('changes'),
  type: text('type'),
  severity: text('severity'),
  title: text('title'),
  body: text('body'),
  read: boolean('read'),
  branchId: text('branch_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

/** Workspace-scoped documents: an arbitrary FK column — not
 *  organizationId — carries the numbering scope. */
export const workdocs = pgTable('wh_workdocs', {
  id: text('id').primaryKey(),
  number: text('number'),
  workspaceId: text('workspace_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

/** Trio-convention audit table: createdAt but NO at column. */
export const trioAudit = pgTable('wh_trio_audit', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }),
  actorId: text('actor_id'),
  actorName: text('actor_name'),
  action: text('action'),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  entityLabel: text('entity_label'),
  changes: jsonb('changes'),
});

/** Trio-convention notification table: createdAt, no at, no read column. */
export const trioNotes = pgTable('wh_trio_notes', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }),
  severity: text('severity'),
  title: text('title'),
  body: text('body'),
});

/** Doc-store fixture: jsonb data + epoch-ms trio. */
export const docsDocs = pgTable('wh_docstore', {
  id: text('id').primaryKey(),
  data: jsonb('data'),
  createdAt: bigint('created_at', { mode: 'number' }),
  updatedAt: bigint('updated_at', { mode: 'number' }),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
});

/** Doc-store users fixture: typed columns beside the doc body. */
export const docsUsers = pgTable('wh_docstore_users', {
  id: text('id').primaryKey(),
  data: jsonb('data'),
  email: text('email'),
  name: text('name'),
  createdAt: bigint('created_at', { mode: 'number' }),
  updatedAt: bigint('updated_at', { mode: 'number' }),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
});
