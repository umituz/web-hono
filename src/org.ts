import { eq } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { CrudDb } from './crud';

export type UsersLike = PgTable & { id: PgColumn; organizationId: PgColumn };
export type OrgsLike = PgTable & { id: PgColumn; modes: PgColumn };
export type NumberedTable = PgTable & { number: PgColumn; organizationId: PgColumn };

/** Organization of the acting user; missing actor → fallback. */
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

export async function orgHasMode(db: CrudDb, orgs: OrgsLike, orgId: string, mode: string): Promise<boolean> {
  const [org] = await db.select({ modes: orgs.modes }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  return Array.isArray(org?.modes) && (org.modes as string[]).includes(mode);
}

/** Next `PREFIX-n` document number: max numeric suffix +1. Not a
 *  reservation — the partial-unique on number turns races into a 409. */
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
