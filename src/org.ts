import { and, eq, isNull } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { CrudDb } from './crud';

export type UsersLike = PgTable & { id: PgColumn; organizationId: PgColumn };
export type OrgsLike = PgTable & { id: PgColumn; modes: PgColumn };
export type NumberedTable = PgTable & { number?: PgColumn; organizationId?: PgColumn; deletedAt?: PgColumn };

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

/** Next `PREFIX-n` (or `PREFIX-YYYY-NNNN` with year: true) document number:
 *  max numeric suffix +1 among the current year's live rows. Not a
 *  reservation — the partial-unique on number turns races into a 409.
 *  pad applies in EVERY mode — plain `pad: 4` yields `PRD-0001` and reads
 *  padded/legacy rows alike (`PRD-9` still counts as 9). digitsOnly: true
 *  serves prefix-less columns that store the bare integer ("101") — prefix
 *  is ignored, non-numeric rows don't count. */
export async function nextNumber(
  db: CrudDb,
  table: NumberedTable,
  prefix: string,
  opts: {
    orgId?: string;
    base?: number;
    year?: boolean;
    pad?: number;
    column?: PgColumn;
    digitsOnly?: boolean;
    separator?: string;
  } = {},
): Promise<string> {
  const numberCol = opts.column ?? table.number;
  if (!numberCol) throw new Error('nextNumber: no number column (pass opts.column for orderNo-style tables)');
  const conds = [];
  if (opts.orgId && table.organizationId) conds.push(eq(table.organizationId, opts.orgId));
  if (table.deletedAt) conds.push(isNull(table.deletedAt));
  const rows = await db
    .select({ number: numberCol })
    .from(table)
    .where(conds.length > 0 ? and(...conds) : undefined);
  const bare = opts.digitsOnly === true;
  const withYear = !bare && opts.year === true;
  const year = new Date().getFullYear();
  const sep = bare ? '' : (opts.separator ?? '-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pat = bare ? /^(\d+)$/ : withYear ? new RegExp(`^${prefix}-${year}-(\\d+)$`) : new RegExp(`^${prefix}${sep}(\\d+)$`);
  const max = rows.reduce((m, r) => {
    const n = pat.exec(String(r.number ?? ''))?.[1];
    return n ? Math.max(m, Number(n)) : m;
  }, opts.base ?? (bare ? 0 : withYear ? 0 : 2000));
  const n = max + 1;
  if (bare) return opts.pad ? String(n).padStart(opts.pad, '0') : String(n);
  const body = String(n).padStart(opts.pad ?? (withYear ? 4 : 0), '0');
  return withYear ? `${prefix}-${year}-${body}` : `${prefix}${opts.separator ?? '-'}${body}`;
}
