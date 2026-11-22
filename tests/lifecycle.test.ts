import { describe, expect, it } from 'vitest';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { resetTables, snapshotToBytes } from '../src/lifecycle';
import type { SnapshotDb } from '../src/lifecycle';
import { makeTestDb, resetDb, resetOrgDb } from './pglite';
import { orgs, widgets } from './helpers';

const rogue = pgTable('rogue_table', { id: text('id').primaryKey() });

describe('resetTables safety', () => {
  it('refuses to drop a table without the fleet prefix', async () => {
    await expect(
      resetTables({ specs: [{ name: 'rogue', table: rogue }], prefix: 'wh_', url: 'postgresql://user:pass@localhost:5432/db' }),
    ).rejects.toThrow(/Safety stop: 'rogue_table' does not carry prefix 'wh_'/);
  });
});

describe('snapshotToBytes', () => {
  it('gzips every table and round-trips through gunzip', async () => {
    const db = await makeTestDb();
    await resetDb();
    await resetOrgDb();
    await db.insert(widgets).values([
      { id: 'w1', name: 'alpha' },
      { id: 'w2', name: 'beta' },
    ]);
    await db.insert(orgs).values([{ id: 'o1' }]);

    const result = await snapshotToBytes({
      specs: [
        { name: 'wh_widgets', table: widgets },
        { name: 'wh_orgs', table: orgs },
      ],
      db: db as unknown as SnapshotDb,
    });

    expect(result.total).toBe(3);
    expect(result.rawBytes).toBeGreaterThan(0);
    expect(result.generatedAt).toBeTruthy();

    const gunzipped = new Blob([result.bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    const parsed = JSON.parse(await new Response(gunzipped).text()) as {
      generatedAt: string;
      tables: Record<string, { id: string }[]>;
    };
    expect(parsed.generatedAt).toBe(result.generatedAt);
    expect(parsed.tables.wh_widgets?.map((r) => r.id).sort()).toEqual(['w1', 'w2']);
    expect(parsed.tables.wh_orgs).toHaveLength(1);
  }, 20000);
});
