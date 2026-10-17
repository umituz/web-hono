import { beforeEach, describe, expect, it } from 'vitest';
import { resolveOrg, orgHasMode, nextNumber } from '../src/org';
import { writeAudit, writeNotification } from '../src/activity';
import { makeTestDb, resetOrgDb } from './pglite';
import { orgUsers, orgs, documents, activities } from './helpers';
import type { CrudDb } from '../src/crud';

/* REAL-database coverage (in-memory Postgres) of the org-scoped helpers
 *  and activity writes — the exact behaviors the fleet hand-copied per
 *  project: actor→org resolution with demo fallback, hard mode gates,
 *  prefix-scoped document numbering, and audit/notification appends with
 *  server-stamped id/at/defaults. */

let db: CrudDb;

beforeEach(async () => {
  db = await makeTestDb();
  await resetOrgDb();
});

describe('resolveOrg', () => {
  it('returns the actor user organization', async () => {
    await db.insert(orgUsers).values({ id: 'usr_1', organizationId: 'org_a' } as never);
    expect(await resolveOrg(db, orgUsers, 'usr_1', 'org_demo')).toBe('org_a');
  });

  it('falls back for an unknown actor', async () => {
    expect(await resolveOrg(db, orgUsers, 'usr_ghost', 'org_demo')).toBe('org_demo');
  });

  it('falls back when no actor is given', async () => {
    expect(await resolveOrg(db, orgUsers, undefined, 'org_demo')).toBe('org_demo');
  });
});

describe('orgHasMode', () => {
  it('is true when the org runs the mode', async () => {
    await db.insert(orgs).values({ id: 'org_a', modes: ['restaurant', 'catering'] } as never);
    expect(await orgHasMode(db, orgs, 'org_a', 'catering')).toBe(true);
  });

  it('is false for another mode, a missing org, or non-array modes', async () => {
    await db.insert(orgs).values({ id: 'org_a', modes: ['restaurant'] } as never);
    await db.insert(orgs).values({ id: 'org_b', modes: null } as never);
    expect(await orgHasMode(db, orgs, 'org_a', 'bakery')).toBe(false);
    expect(await orgHasMode(db, orgs, 'org_ghost', 'bakery')).toBe(false);
    expect(await orgHasMode(db, orgs, 'org_b', 'bakery')).toBe(false);
  });
});

describe('nextNumber', () => {
  it('starts at base + 1 on an empty table', async () => {
    expect(await nextNumber(db, documents, 'BAT', { orgId: 'org_a' })).toBe('BAT-2001');
    expect(await nextNumber(db, documents, 'CI', { base: 1000 })).toBe('CI-1001');
  });

  it('continues the max suffix and ignores other prefixes', async () => {
    await db.insert(documents).values([
      { id: 'd1', number: 'BAT-2007', organizationId: 'org_a' },
      { id: 'd2', number: 'BAT-9', organizationId: 'org_a' },
      { id: 'd3', number: 'WO-9999', organizationId: 'org_a' },
      { id: 'd4', number: 'garbage', organizationId: 'org_a' },
    ] as never);
    expect(await nextNumber(db, documents, 'BAT', { orgId: 'org_a' })).toBe('BAT-2008');
  });

  it('scopes to the org; without orgId it is fleet-global', async () => {
    await db.insert(documents).values([
      { id: 'd1', number: 'INV-5003', organizationId: 'org_a' },
      { id: 'd2', number: 'INV-5009', organizationId: 'org_b' },
    ] as never);
    expect(await nextNumber(db, documents, 'INV', { orgId: 'org_a', base: 5000 })).toBe('INV-5004');
    expect(await nextNumber(db, documents, 'INV', { base: 5000 })).toBe('INV-5010');
  });

  it('year mode numbers PREFIX-YYYY-NNNN and ignores other years and pads', async () => {
    const year = new Date().getFullYear();
    await db.insert(documents).values([
      { id: 'd1', number: `SO-${year}-0007`, organizationId: 'org_a' },
      { id: 'd2', number: `SO-${year - 1}-0099`, organizationId: 'org_a' },
      { id: 'd3', number: `SO-${year}-99`, organizationId: 'org_b' },
    ] as never);
    expect(await nextNumber(db, documents, 'SO', { orgId: 'org_a', year: true })).toBe(`SO-${year}-0008`);
    expect(await nextNumber(db, documents, 'SO', { year: true, pad: 2, base: 40 })).toBe(`SO-${year}-100`);
  });

  it('ignores soft-deleted rows when the table carries deletedAt', async () => {
    await db.insert(documents).values([
      { id: 'd1', number: 'BAT-2009', organizationId: 'org_a', deletedAt: new Date() },
      { id: 'd2', number: 'BAT-2004', organizationId: 'org_a' },
    ] as never);
    expect(await nextNumber(db, documents, 'BAT', { orgId: 'org_a' })).toBe('BAT-2005');
  });
});

describe('writeAudit / writeNotification', () => {
  it('appends an audit row with server-stamped id/at and changes default', async () => {
    await writeAudit(db, activities, {
      actorId: 'usr_1',
      actorName: 'Ada',
      action: 'order.created',
      entityType: 'order',
      entityId: 'ord_1',
      entityLabel: 'TVL-1002',
      branchId: 'br_1',
    });
    const rows = (await db.select().from(activities)) as unknown as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^aud_/);
    expect(rows[0].at).toBeInstanceOf(Date);
    expect(rows[0].changes).toEqual([]);
    expect(rows[0].branchId).toBe('br_1');
    expect(rows[0].actorName).toBe('Ada');
  });

  it('keeps provided changes and honors a custom id prefix', async () => {
    await writeAudit(
      db,
      activities,
      {
        actorId: 'usr_1',
        actorName: 'Ada',
        action: 'a',
        entityType: 'e',
        entityId: '1',
        entityLabel: 'L',
        changes: [{ field: 'status', from: 'new', to: 'done' }],
      },
      'log',
    );
    const rows = (await db.select().from(activities)) as unknown as Record<string, unknown>[];
    expect(rows[0].id).toMatch(/^log_/);
    expect(rows[0].changes).toEqual([{ field: 'status', from: 'new', to: 'done' }]);
  });

  it('appends a notification row stamped unread', async () => {
    await writeNotification(db, activities, {
      type: 'order.placed',
      severity: 'info',
      title: 'New order',
      body: 'TVL-1002 came in',
    });
    const rows = (await db.select().from(activities)) as unknown as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^ntf_/);
    expect(rows[0].read).toBe(false);
    expect(rows[0].at).toBeInstanceOf(Date);
  });
});
