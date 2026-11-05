import { getTableColumns } from 'drizzle-orm';
import { timestamp } from 'drizzle-orm/pg-core';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

let idCounter = 0;
export function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function actor(input: { actorId?: string; actorName?: string }, name = 'Back office'): { actorId: string; actorName: string } {
  return { actorId: input.actorId ?? 'api', actorName: input.actorName ?? name };
}

export function trio() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  };
}

const PROTECTED_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt']);

function localDateStamp(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function stampUpdate(table: PgTable): Record<string, unknown> {
  const columns = getTableColumns(table) as unknown as Record<string, { columnType: string }>;
  const updatedAt = columns.updatedAt;
  if (!updatedAt) return {};
  return updatedAt.columnType.includes('Timestamp') ? { updatedAt: new Date() } : { updatedAt: localDateStamp() };
}

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
      if (Number.isNaN(d.getTime())) continue;
      out[key] = d;
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

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

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
}
