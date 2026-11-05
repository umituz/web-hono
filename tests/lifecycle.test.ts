import { describe, expect, it } from 'vitest';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { resetTables } from '../src/lifecycle';

const rogue = pgTable('rogue_table', { id: text('id').primaryKey() });

describe('resetTables safety', () => {
  it('refuses to drop a table without the fleet prefix', async () => {
    await expect(
      resetTables({ specs: [{ name: 'rogue', table: rogue }], prefix: 'wh_', url: 'postgresql://user:pass@localhost:5432/db' }),
    ).rejects.toThrow(/Safety stop: 'rogue_table' does not carry prefix 'wh_'/);
  });
});
