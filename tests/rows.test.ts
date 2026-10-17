import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { findRow, softDelete } from '../src/rows';
import { actor, ApiError } from '../src/index';
import { makeTestDb, resetDb } from './pglite';
import { widgets } from './helpers';
import type { CrudDb } from '../src/crud';

let db: CrudDb;

beforeEach(async () => {
  db = await makeTestDb();
  await resetDb();
});

describe('findRow', () => {
  it('returns the live row', async () => {
    await db.insert(widgets).values({ id: 'w1', name: 'Cog' } as never);
    const row = await findRow(db, widgets, 'w1', 'Widget');
    expect(row.id).toBe('w1');
    expect(row.name).toBe('Cog');
  });

  it('throws the envelope 404 on a miss', async () => {
    await expect(findRow(db, widgets, 'w_ghost', 'Widget')).rejects.toMatchObject({
      status: 404,
      message: 'Widget not found',
    });
  });

  it('hides soft-deleted rows', async () => {
    await db.insert(widgets).values({ id: 'w1', name: 'Cog' } as never);
    await db.update(widgets).set({ deletedAt: new Date() }).where(eq(widgets.id, 'w1'));
    await expect(findRow(db, widgets, 'w1', 'Widget')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('softDelete', () => {
  it('stamps deletedAt and updatedAt, returns the row', async () => {
    await db.insert(widgets).values({ id: 'w1', name: 'Cog' } as never);
    const before = Date.now() - 1000;
    const row = await softDelete(db, widgets, 'w1', 'Widget');
    expect(row.id).toBe('w1');
    expect(row.deletedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.updatedAt?.getTime()).toBeGreaterThanOrEqual(before);
    await expect(findRow(db, widgets, 'w1', 'Widget')).rejects.toBeInstanceOf(ApiError);
  });

  it('throws notFound when already deleted (idempotent second delete)', async () => {
    await db.insert(widgets).values({ id: 'w1', name: 'Cog' } as never);
    await softDelete(db, widgets, 'w1', 'Widget');
    await expect(softDelete(db, widgets, 'w1', 'Widget')).rejects.toMatchObject({ status: 404 });
  });
});

describe('actor', () => {
  it('applies the fleet defaults', () => {
    expect(actor({})).toEqual({ actorId: 'api', actorName: 'Back office' });
  });

  it('keeps given values and honors the name fallback', () => {
    expect(actor({ actorId: 'usr_1' }, 'Courier')).toEqual({ actorId: 'usr_1', actorName: 'Courier' });
    expect(actor({ actorId: 'usr_1', actorName: 'Mira' })).toEqual({ actorId: 'usr_1', actorName: 'Mira' });
  });
});
