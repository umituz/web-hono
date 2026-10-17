import { eq } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { CrudDb } from './crud';

/**
 * Org-scoped server helpers — the three lookups every area router of a
 * multi-org app hand-copied (fleet audit, 17 Oct 2026: the pilot alone
 * carried orgOf ×4, mode gates ×2 and number sequences ×6 as per-file
 * copies with drifting signatures).
 *
 * All three take the app's own tables as parameters — the schema stays
 * project-owned (TABLE_PREFIX); only the cross-cutting behavior lives
 * here. Bind once in api/lib.ts and re-export; routes keep importing
 * from '../lib'.
 */

/** users-table shape resolveOrg reads (fleet users template, SaaS_BUILD 4.5). */
export type UsersLike = PgTable & { id: PgColumn; organizationId: PgColumn };
/** organizations-table shape orgHasMode reads (modular platforms, 8.2). */
export type OrgsLike = PgTable & { id: PgColumn; modes: PgColumn };
/** Table shape nextNumber counts against — org-scoped document rows. */
export type NumberedTable = PgTable & { number: PgColumn; organizationId: PgColumn };

/** Organization of the acting user; unknown or missing actor → fallback
 *  (the demo org). Single lookup — the fallback is by definition a known
 *  org, no existence re-check needed. */
export async function resolveOrg(
  db: CrudDb,
  users: UsersLike,
  actorId: string | undefined,
  fallback: string,
): Promise<string> {
  if (actorId) {
    const [row] = await db
      .select({ organizationId: users.organizationId })
      .from(users)
      .where(eq(users.id, actorId))
      .limit(1);
    if (row) return row.organizationId as string;
  }
  return fallback;
}

/** Does this org run the given business mode? (Hard mode gates, 8.2 —
 *  a non-mode org is rejected on every write of that arm.) */
export async function orgHasMode(db: CrudDb, orgs: OrgsLike, orgId: string, mode: string): Promise<boolean> {
  const [org] = await db.select({ modes: orgs.modes }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  return Array.isArray(org?.modes) && (org.modes as string[]).includes(mode);
}

/** Next `PREFIX-n` document number: max numeric suffix among the (org's)
 *  rows, +1. Non-matching numbers are ignored; empty table → base + 1.
 *  Omit orgId for fleet-global sequences. Not a reservation — two racing
 *  writes can draw the same number; the partial-unique on number (4.5)
 *  turns that into a retryable 409. */
export async function nextNumber(
  db: CrudDb,
  table: NumberedTable,
  prefix: string,
  opts: { orgId?: string; base?: number } = {},
): Promise<string> {
  const q = db.select({ number: table.number }).from(table);
  const rows = opts.orgId ? await q.where(eq(table.organizationId, opts.orgId)) : await q;
  const max = rows.reduce((m, r) => {
    const n = new RegExp(`^${prefix}-(\\d+)$`).exec(String(r.number ?? ''))?.[1];
    return n ? Math.max(m, Number(n)) : m;
  }, opts.base ?? 2000);
  return `${prefix}-${max + 1}`;
}
