import { describe, expect, it } from 'vitest';
import { auditAction, diffChanges } from '../src/activity';
import { activities } from './helpers';
import type { CrudDb } from '../src/crud';

describe('diffChanges', () => {
  it('detects modified primitive fields', () => {
    const before = { name: 'Old Name', age: 30, city: 'London' };
    const after = { name: 'New Name', age: 30, city: 'Paris' };
    const changes = diffChanges(before, after);
    expect(changes).toEqual([
      { field: 'name', from: 'Old Name', to: 'New Name' },
      { field: 'city', from: 'London', to: 'Paris' },
    ]);
  });

  it('skips excluded fields by default', () => {
    const before = { id: 'usr-1', updatedAt: '2026-01-01', password: 'old', role: 'member' };
    const after = { id: 'usr-1', updatedAt: '2026-01-02', password: 'new', role: 'admin' };
    const changes = diffChanges(before, after);
    expect(changes).toEqual([
      { field: 'role', from: 'member', to: 'admin' },
    ]);
  });

  it('handles objects and stringifies them when different', () => {
    const before = { metadata: { tier: 'gold' } };
    const after = { metadata: { tier: 'platinum' } };
    const changes = diffChanges(before, after);
    expect(changes).toEqual([
      { field: 'metadata', from: '{"tier":"gold"}', to: '{"tier":"platinum"}' },
    ]);
  });

  it('skips identical objects', () => {
    const before = { metadata: { tier: 'gold' } };
    const after = { metadata: { tier: 'gold' } };
    const changes = diffChanges(before, after);
    expect(changes).toEqual([]);
  });

  it('respects custom exclude list', () => {
    const before = { status: 'draft', internalNotes: 'secret note' };
    const after = { status: 'published', internalNotes: 'updated note' };
    const changes = diffChanges(before, after, { exclude: ['internalNotes'] });
    expect(changes).toEqual([
      { field: 'status', from: 'draft', to: 'published' },
    ]);
  });
});

describe('auditAction', () => {
  it('calls writeAudit with computed diff and actor details', async () => {
    const insertedValues: unknown[] = [];
    const mockDb = {
      insert: () => ({
        values: (val: unknown) => {
          insertedValues.push(val);
          return Promise.resolve();
        },
      }),
    } as unknown as CrudDb;

    const actor = { actorId: 'usr-99', actorName: 'Alice Admin' };
    const before = { title: 'Draft Post', active: false };
    const after = { title: 'Published Post', active: true };

    await auditAction(
      mockDb,
      activities,
      actor,
      'post.updated',
      { type: 'post', id: 'pst-1', label: 'My Post' },
      before,
      after,
    );

    expect(insertedValues.length).toBe(1);
    const entry = insertedValues[0] as Record<string, unknown>;
    expect(entry.actorId).toBe('usr-99');
    expect(entry.actorName).toBe('Alice Admin');
    expect(entry.action).toBe('post.updated');
    expect(entry.entityType).toBe('post');
    expect(entry.entityId).toBe('pst-1');
    expect(entry.entityLabel).toBe('My Post');
    expect(entry.changes).toEqual([
      { field: 'title', from: 'Draft Post', to: 'Published Post' },
      { field: 'active', from: 'false', to: 'true' },
    ]);
  });
});
