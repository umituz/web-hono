import { getTableColumns } from 'drizzle-orm';
import { timestamp } from 'drizzle-orm/pg-core';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/** Server-side id generation: `${prefix}_${base36 timestamp}${base36 counter}`. */
let idCounter = 0;
export function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** Write-schema actor pair with the fleet defaults. */
export function actor(input: { actorId?: string; actorName?: string }, name = 'Back office'): { actorId: string; actorName: string } {
  return { actorId: input.actorId ?? 'api', actorName: input.actorName ?? name };
}

/**
 * Fleet time-trio columns for timestamptz tables — spread into a pgTable
 * definition: `{ id: text('id').primaryKey(), name: text('name'), ...trio() }`.
 * One encoding of the fleet standard instead of the three (inline columns,
 * factory functions, spread objects) the 1.x apps each hand-rolled.
 */
export function trio() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  };
}

/** Fields no client may ever patch. */
const PROTECTED_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt']);

/** Local calendar day as 'YYYY-MM-DD' — the stamp for date-string columns. */
function localDateStamp(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * updatedAt stamp matching the table's column type. Fleet-standard tables
 * (timestamp withTimezone) get a Date — unchanged from previous versions.
 * Domains that model updatedAt as a calendar date column (date string,
 * date-string) get today's local 'YYYY-MM-DD' instead of a Date that the
 * column cannot carry.
 */
export function stampUpdate(table: PgTable): Record<string, unknown> {
  const columns = getTableColumns(table) as unknown as Record<string, { columnType: string }>;
  const updatedAt = columns.updatedAt;
  // No updatedAt column → stamp nothing; stamping a nonexistent column would
  // fail the drizzle update at runtime.
  if (!updatedAt) return {};
  return updatedAt.columnType.includes('Timestamp') ? { updatedAt: new Date() } : { updatedAt: localDateStamp() };
}

/**
 * Filters a JSON patch body down to the table's own columns (drizzle speaks
 * the camelCase schema PROPERTY names — which are the domain field names).
 * ISO-datetime strings destined for timestamptz columns become Date objects.
 * Returns null when nothing updatable remains.
 */
export function pickPatch(table: PgTable, body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const columns = getTableColumns(table) as unknown as Record<string, { columnType: string }>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (PROTECTED_KEYS.has(key)) continue;
    const col = columns[key];
    if (!col || value === undefined) continue;
    if (typeof value === 'string' && col.columnType.includes('Timestamp')) {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) continue; // '' and junk → skip, not 500
      out[key] = d;
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Column-type check for schema-less patches (the crudRoutes PATCH path):
 * a JSON value whose primitive type contradicts the column's drizzle
 * dataType would otherwise surface as a driver 500. Returns the details
 * object for the 400 envelope, or null when every value fits.
 */
export function patchTypeErrors(table: PgTable, patch: Record<string, unknown>): Record<string, string[]> | null {
  const columns = getTableColumns(table) as unknown as Record<string, PgColumn>;
  const errors: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(patch)) {
    const col = columns[key];
    if (!col) continue;
    let msg: string | null = null;
    switch (col.dataType) {
      case 'string':
        msg = typeof value === 'string' ? null : 'expected string';
        break;
      case 'number':
        msg = typeof value === 'number' && Number.isFinite(value) ? null : 'expected number';
        break;
      case 'boolean':
        msg = typeof value === 'boolean' ? null : 'expected boolean';
        break;
      case 'date':
        msg = typeof value === 'string' || value instanceof Date ? null : 'expected date string';
        break;
      default:
        break;
    }
    if (msg) errors[key] = [msg];
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * Normalizes a create payload against the table before insert: drops keys
 * that are not table columns, turns ISO-datetime strings destined for
 * timestamptz columns into Dates, and maps '' to NULL on nullable columns
 * (empty form fields). The insert-side twin of pickPatch.
 */
export function normalizeRow(table: PgTable, input: Record<string, unknown>): Record<string, unknown> {
  const columns = getTableColumns(table) as unknown as Record<string, { columnType: string; notNull: boolean }>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (PROTECTED_KEYS.has(key)) continue;
    const col = columns[key];
    if (!col || value === undefined) continue;
    if (typeof value === 'string' && col.columnType.includes('Timestamp')) {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) continue;
      out[key] = d;
    } else if (value === '' && !col.notNull) {
      out[key] = null;
    } else {
      out[key] = value;
    }
  }
  return out;
}
