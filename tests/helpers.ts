import { pgTable, text, timestamp, integer, date, jsonb, boolean, bigint, primaryKey } from 'drizzle-orm/pg-core';

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

export const journals = pgTable('wh_journals', {
  id: text('id').primaryKey(),
  note: text('note'),
  createdAt: date('created_at', { mode: 'string' }).notNull(),
  updatedAt: date('updated_at', { mode: 'string' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

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

export const workdocs = pgTable('wh_workdocs', {
  id: text('id').primaryKey(),
  number: text('number'),
  workspaceId: text('workspace_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

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

export const trioNotes = pgTable('wh_trio_notes', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }),
  severity: text('severity'),
  title: text('title'),
  body: text('body'),
});

export const docsDocs = pgTable('wh_docstore', {
  id: text('id').primaryKey(),
  data: jsonb('data'),
  createdAt: bigint('created_at', { mode: 'number' }),
  updatedAt: bigint('updated_at', { mode: 'number' }),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
});

export const docsUsers = pgTable('wh_docstore_users', {
  id: text('id').primaryKey(),
  data: jsonb('data'),
  email: text('email'),
  name: text('name'),
  createdAt: bigint('created_at', { mode: 'number' }),
  updatedAt: bigint('updated_at', { mode: 'number' }),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
});

export const docsScoped = pgTable(
  'wh_docstore_scoped',
  {
    id: text('id'),
    facilityId: text('facility_id'),
    data: jsonb('data'),
    createdAt: bigint('created_at', { mode: 'number' }),
    updatedAt: bigint('updated_at', { mode: 'number' }),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.facilityId, t.id] })],
);

export const textNotes = pgTable('wh_text_notes', {
  id: text('id').primaryKey(),
  at: text('at'),
  severity: text('severity'),
  title: text('title'),
  body: text('body'),
});
