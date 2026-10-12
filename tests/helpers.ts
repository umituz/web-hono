import { pgTable, text, timestamp, integer, date } from 'drizzle-orm/pg-core';

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
