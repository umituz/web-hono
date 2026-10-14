import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

/** Server-side id generation: `${prefix}_${base36 timestamp}${base36 counter}`. */
let idCounter = 0;
export function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
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
 * e.g. polaris) get today's local 'YYYY-MM-DD' instead of a Date that the
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
