import { getTableName, getTableColumns } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import type { PgTable } from 'drizzle-orm/pg-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';

export interface TableSpec {
  name: string;
  table: PgTable;
}

export interface SeedSnapshot {
  generatedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

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

export async function seedFromSnapshot(opts: { specs: TableSpec[]; url: string; inPath: string | URL }): Promise<number> {
  const db = drizzle(neon(opts.url));

  const snapshot = JSON.parse(gunzipSync(readFileSync(opts.inPath)).toString('utf8')) as SeedSnapshot;
  console.log(`Snapshot generated at ${snapshot.generatedAt}`);

  let inserted = 0;
  for (const { name, table } of opts.specs) {
    const rows = (snapshot.tables[name] ?? []).map((r) => reviveRow(table, r));
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const res = (await db.insert(table).values(chunk as never).onConflictDoNothing().returning()) as unknown[];
      inserted += res.length;
    }
    console.log(`${name.padEnd(20)} ${rows.length} offered`);
  }
  console.log(`\nSeed complete: ${inserted} rows inserted (existing ids skipped).`);
  return inserted;
}
