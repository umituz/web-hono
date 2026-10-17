import { pgTable, text, timestamp, integer, date, jsonb, boolean } from 'drizzle-orm/pg-core';

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

/** Date-string-stamped table (polaris convention): updatedAt is a calendar
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
