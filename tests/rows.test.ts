import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { findOrgRow, findRow, softDelete, softDeleteOrgRow } from '../src/rows';
import { ApiError } from '../src/index';
import { makeTestDb, resetDb, resetOrgDb } from './pglite';
import { documents, widgets } from './helpers';
import type { CrudDb } from '../src/crud';

let db: CrudDb;

beforeEach(async () => {
  db = await makeTestDb();
  await resetDb();
  await resetOrgDb();
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

describe('findOrgRow', () => {
  it('returns live row when id and organization match', async () => {
    await db.insert(documents).values({ id: 'd1', organizationId: 'org_a', number: 'DOC-1' } as never);
    const row = await findOrgRow(db, documents, 'd1', 'org_a', 'Document');
    expect(row.id).toBe('d1');
    expect(row.number).toBe('DOC-1');
  });

  it('throws 404 on organization mismatch', async () => {
    await db.insert(documents).values({ id: 'd1', organizationId: 'org_a', number: 'DOC-1' } as never);
    await expect(findOrgRow(db, documents, 'd1', 'org_b', 'Document')).rejects.toMatchObject({
      status: 404,
      message: 'Document not found',
    });
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

describe('softDeleteOrgRow', () => {
  it('soft-deletes row scoped to organization', async () => {
    await db.insert(documents).values({ id: 'd2', organizationId: 'org_x', number: 'DOC-2' } as never);
    const deleted = await softDeleteOrgRow(db, documents, 'd2', 'org_x', 'Document');
    expect(deleted.id).toBe('d2');
    expect(deleted.deletedAt).toBeDefined();
    await expect(findOrgRow(db, documents, 'd2', 'org_x', 'Document')).rejects.toMatchObject({ status: 404 });
  });

  it('throws 404 when deleting document with wrong organization', async () => {
    await db.insert(documents).values({ id: 'd3', organizationId: 'org_x', number: 'DOC-3' } as never);
    await expect(softDeleteOrgRow(db, documents, 'd3', 'org_wrong', 'Document')).rejects.toMatchObject({ status: 404 });
  });
});
