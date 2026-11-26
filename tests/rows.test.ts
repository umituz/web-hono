import { beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import {
  findOrgRow,
  findRow,
  updateOrgRow,
  softDelete,
  softDeleteOrgRow,
  deleteOrgRow,
  findManyByOrg,
  countOrgRows,
  paginateOrgRows,
} from '../src/rows';
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

describe('updateOrgRow', () => {
  it('updates live row scoped to organization', async () => {
    await db.insert(documents).values({ id: 'd4', organizationId: 'org_m', number: 'OLD-4' } as never);
    const updated = await updateOrgRow(db, documents, 'd4', 'org_m', { number: 'NEW-4' }, 'Document');
    expect(updated.id).toBe('d4');
    expect(updated.number).toBe('NEW-4');
  });

  it('throws 404 on organization mismatch', async () => {
    await db.insert(documents).values({ id: 'd5', organizationId: 'org_m', number: 'DOC-5' } as never);
    await expect(
      updateOrgRow(db, documents, 'd5', 'org_wrong', { number: 'ATTACK' }, 'Document')
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('deleteOrgRow', () => {
  it('hard-deletes row scoped to organization', async () => {
    await db.insert(documents).values({ id: 'd6', organizationId: 'org_del', number: 'DEL-6' } as never);
    const deleted = await deleteOrgRow(db, documents, 'd6', 'org_del', 'Document');
    expect(deleted.id).toBe('d6');
    await expect(findOrgRow(db, documents, 'd6', 'org_del', 'Document')).rejects.toMatchObject({ status: 404 });
  });

  it('throws 404 when deleting row from different organization', async () => {
    await db.insert(documents).values({ id: 'd7', organizationId: 'org_del', number: 'DEL-7' } as never);
    await expect(deleteOrgRow(db, documents, 'd7', 'org_wrong', 'Document')).rejects.toMatchObject({ status: 404 });
  });
});

describe('findManyByOrg', () => {
  it('returns all live rows belonging to organization', async () => {
    await db.insert(documents).values({ id: 'm1', organizationId: 'org_many', number: 'DOC-1' } as never);
    await db.insert(documents).values({ id: 'm2', organizationId: 'org_many', number: 'DOC-2' } as never);
    await db.insert(documents).values({ id: 'm3', organizationId: 'org_other', number: 'DOC-3' } as never);
    await db.insert(documents).values({ id: 'm4', organizationId: 'org_many', number: 'DOC-4', deletedAt: new Date() } as never);

    const rows = await findManyByOrg(db, documents, 'org_many');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['m1', 'm2']);
  });

  it('respects limit, offset, and orderBy', async () => {
    await db.insert(documents).values({ id: 'p1', organizationId: 'org_page', number: 'A' } as never);
    await db.insert(documents).values({ id: 'p2', organizationId: 'org_page', number: 'B' } as never);
    await db.insert(documents).values({ id: 'p3', organizationId: 'org_page', number: 'C' } as never);

    const rows = await findManyByOrg(db, documents, 'org_page', {
      limit: 1,
      offset: 1,
      orderBy: desc(documents.number),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.number).toBe('B');
  });
});

describe('countOrgRows', () => {
  it('counts only active rows for the organization', async () => {
    await db.insert(documents).values({ id: 'c1', organizationId: 'org_count', number: 'DOC-1' } as never);
    await db.insert(documents).values({ id: 'c2', organizationId: 'org_count', number: 'DOC-2' } as never);
    await db.insert(documents).values({ id: 'c3', organizationId: 'org_count', number: 'DOC-3', deletedAt: new Date() } as never);
    await db.insert(documents).values({ id: 'c4', organizationId: 'org_diff', number: 'DOC-4' } as never);

    const count = await countOrgRows(db, documents, 'org_count');
    expect(count).toBe(2);
  });
});

describe('paginateOrgRows', () => {
  it('paginates rows with metadata', async () => {
    for (let i = 1; i <= 5; i++) {
      await db.insert(documents).values({ id: `pg_${i}`, organizationId: 'org_pg', number: `N-${i}` } as never);
    }
    await db.insert(documents).values({ id: 'pg_del', organizationId: 'org_pg', number: 'N-DEL', deletedAt: new Date() } as never);

    const res = await paginateOrgRows(db, documents, 'org_pg', {
      page: 2,
      pageSize: 2,
    });
    expect(res.total).toBe(5);
    expect(res.page).toBe(2);
    expect(res.pageSize).toBe(2);
    expect(res.totalPages).toBe(3);
    expect(res.items).toHaveLength(2);
  });
});
