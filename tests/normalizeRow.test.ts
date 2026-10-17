import { describe, expect, it } from 'vitest';
import { normalizeRow } from '../src/lib';
import { widgets } from './helpers';

describe('normalizeRow', () => {
  it('drops protected keys and unknown columns, keeps real ones', () => {
    expect(
      normalizeRow(widgets, {
        id: 'w_1',
        createdAt: '2026-01-01T00:00:00Z',
        deletedAt: null,
        bogus: 'x',
        name: 'A',
      }),
    ).toEqual({ name: 'A' });
  });

  it('coerces ISO strings to Date for timestamptz columns only', () => {
    const row = normalizeRow(widgets, { openedAt: '2026-05-05T10:00:00Z', bestBefore: '2026-06-06', count: 3 });
    expect(row.openedAt).toBeInstanceOf(Date);
    expect(row.bestBefore).toBe('2026-06-06');
    expect(row.count).toBe(3);
  });

  it('maps empty strings to null on nullable columns', () => {
    expect(normalizeRow(widgets, { name: '', bestBefore: '' })).toEqual({ name: null, bestBefore: null });
  });

  it('drops protected keys even when not-null', () => {
    expect(normalizeRow(widgets, { createdAt: '' })).toEqual({});
  });

  it('skips junk timestamp strings instead of throwing', () => {
    expect(normalizeRow(widgets, { openedAt: 'junk', name: 'A' })).toEqual({ name: 'A' });
  });
});
