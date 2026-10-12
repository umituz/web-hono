import { getTableName, getTableColumns } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import type { PgTable } from 'drizzle-orm/pg-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';

/**
 * Database lifecycle for the shared-Neon-project fleet model: one Neon
 * project hosts many products, each living in its own `TABLE_PREFIX*`
 * tables. `specs` is the app's single table registry (foodora's
 * `scripts/tables.ts` shape) shared by all three operations so snapshot
 * and seed can never diverge.
 */

export interface TableSpec {
  /** Snapshot/seed key AND the SQL table name — e.g. 'users' for `foodora_users`. */
  name: string;
  table: PgTable;
}

/** The on-disk shape of a seed snapshot (`seed-data.json.gz`). */
export interface SeedSnapshot {
  generatedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

/**
 * db:reset step 1 — drops THIS product's prefixed tables (the npm script
 * chain then recreates them with `drizzle-kit push` and replays `db:seed`).
 * Clean-slate lifecycle for a shared Neon project: when a product is paused,
 * reset it; when work resumes, the same command brings it fully back.
 *
 * SAFETY: only tables whose SQL name carries the prefix are dropped — other
 * products sharing the Neon project are never touched. A spec without the
 * prefix stops everything before a single DROP runs.
 */
export async function resetTables(opts: { specs: TableSpec[]; prefix: string; url: string }): Promise<string[]> {
  const sql = neon(opts.url);

  const names = opts.specs.map((spec) => getTableName(spec.table));
  const unsafe = names.find((n) => !n.startsWith(opts.prefix));
  if (unsafe !== undefined) throw new Error(`Safety stop: '${unsafe}' does not carry prefix '${opts.prefix}' — refusing to drop.`);

  const dropped: string[] = [];
  for (const name of [...names].reverse()) {
    await sql`DROP TABLE IF EXISTS ${sql.unsafe(`"${name}"`)} CASCADE`;
    dropped.push(name);
    console.log(`dropped: ${name}`);
  }
  console.log(`\n${names.length} '${opts.prefix}*' tables dropped.`);
  return dropped;
}

/**
 * db:snapshot — reads EVERY row of every table (soft-deleted included) and
 * writes the gzipped seed file. Run after meaningful data changes; the
 * snapshot is what `seedFromSnapshot` replays into an empty database.
 * Rows are stored with drizzle PROPERTY names (camelCase), which is exactly
 * what `.values()` speaks — no key mapping on the way back in.
 */
export async function snapshotToSeed(opts: { specs: TableSpec[]; url: string; outPath: string | URL }): Promise<{ total: number; rawBytes: number }> {
  const db = drizzle(neon(opts.url));

  const tables: Record<string, unknown[]> = {};
  let total = 0;
  for (const { name, table } of opts.specs) {
    const rows = (await db.select().from(table)) as unknown[];
    tables[name] = rows;
    total += rows.length;
    console.log(`${name.padEnd(20)} ${rows.length}`);
  }

  const payload = JSON.stringify({ generatedAt: new Date().toISOString(), tables });
  writeFileSync(opts.outPath, gzipSync(Buffer.from(payload, 'utf8')));
  console.log(`\nSnapshot: ${total} rows → ${opts.outPath} (${(payload.length / 1024).toFixed(0)} KiB raw)`);
  return { total, rawBytes: payload.length };
}

type Row = Record<string, unknown>;

/** ISO string → Date for timestamptz columns; trim to YYYY-MM-DD for date columns. */
function reviveRow(table: PgTable, row: Row): Row {
  const out: Row = { ...row };
  for (const [key, col] of Object.entries(getTableColumns(table))) {
    const v = out[key];
    if (v === null || v === undefined) continue;
    if (col.columnType.includes('Timestamp')) out[key] = new Date(v as string);
    else if (col.columnType.toLowerCase().includes('date')) out[key] = String(v).slice(0, 10);
  }
  return out;
}

/**
 * db:seed — replays the snapshot into the database. Idempotent:
 * ON CONFLICT DO NOTHING — first run wins, existing ids skip. JSON
 * round-trip notes: timestamps come back as ISO strings and dates as
 * 'YYYY-MM-DD'; both are converted back per column type (derived from the
 * drizzle schema — no per-table field lists to maintain).
 */
export async function seedFromSnapshot(opts: { specs: TableSpec[]; url: string; inPath: string | URL }): Promise<number> {
  const db = drizzle(neon(opts.url));

  const snapshot = JSON.parse(gunzipSync(readFileSync(opts.inPath)).toString('utf8')) as SeedSnapshot;
  console.log(`Snapshot generated at ${snapshot.generatedAt}`);

  let inserted = 0;
  for (const { name, table } of opts.specs) {
    const rows = (snapshot.tables[name] ?? []).map((r) => reviveRow(table, r));
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      // `.returning()` (full rows) instead of `returning({ id })`: some tables
      // are singletons keyed by organization_id without an id column.
      const res = (await db.insert(table).values(chunk as never).onConflictDoNothing().returning()) as unknown[];
      inserted += res.length;
    }
    console.log(`${name.padEnd(20)} ${rows.length} offered`);
  }
  console.log(`\nSeed complete: ${inserted} rows inserted (existing ids skipped).`);
  return inserted;
}
