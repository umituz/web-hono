import { describe, expect, it } from 'vitest';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { resetTables } from '../src/lifecycle';

/* Only the safety stop is unit-testable — everything else needs a live
 * Neon DB and is proven by the consuming app. The stop
 * fires BEFORE any network call, so the URL below is never contacted. */

const rogue = pgTable('rogue_table', { id: text('id').primaryKey() });

describe('resetTables safety', () => {
  it('refuses to drop a table without the fleet prefix', async () => {
    await expect(
      resetTables({ specs: [{ name: 'rogue', table: rogue }], prefix: 'wh_', url: 'postgresql://user:pass@localhost:5432/db' }),
    ).rejects.toThrow(/Safety stop: 'rogue_table' does not carry prefix 'wh_'/);
  });
});
