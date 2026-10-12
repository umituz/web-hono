import { describe, expect, it } from 'vitest';
import { pickPatch } from '../src/lib';
import { widgets } from './helpers';

describe('pickPatch', () => {
  it('drops protected keys and unknown columns, keeps real ones', () => {
    expect(
      pickPatch(widgets, {
        id: 'w_1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        deletedAt: null,
        bogus: 'x',
        name: 'A',
      }),
    ).toEqual({ name: 'A' });
  });

  it('coerces ISO strings to Date for timestamptz columns only', () => {
    const patch = pickPatch(widgets, { openedAt: '2026-05-05T10:00:00Z', bestBefore: '2026-06-06', count: 3 });
    expect(patch).not.toBeNull();
    const p = patch as Record<string, unknown>;
    expect(p.openedAt).toBeInstanceOf(Date);
    expect(p.bestBefore).toBe('2026-06-06'); // date column passes through
    expect(p.count).toBe(3);
  });

  it('skips junk and empty timestamp strings instead of throwing', () => {
    expect(pickPatch(widgets, { openedAt: 'junk' })).toBeNull();
    expect(pickPatch(widgets, { openedAt: '' })).toBeNull();
    // junk next to a valid key keeps only the valid one
    expect(pickPatch(widgets, { openedAt: 'junk', name: 'A' })).toEqual({ name: 'A' });
  });

  it('returns null for non-object bodies', () => {
    expect(pickPatch(widgets, null)).toBeNull();
    expect(pickPatch(widgets, [1, 2])).toBeNull();
    expect(pickPatch(widgets, 'name=a')).toBeNull();
    expect(pickPatch(widgets, undefined)).toBeNull();
  });

  it('returns null when nothing updatable remains', () => {
    expect(pickPatch(widgets, { id: 'w_1' })).toBeNull();
    expect(pickPatch(widgets, {})).toBeNull();
    expect(pickPatch(widgets, { name: undefined })).toBeNull();
  });
});
