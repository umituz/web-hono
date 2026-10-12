import { describe, expect, it } from 'vitest';
import { uid } from '../src/lib';

describe('uid', () => {
  it('uses the given prefix and base36 shape', () => {
    const id = uid('sup');
    expect(id.startsWith('sup_')).toBe(true);
    expect(id).toMatch(/^sup_[0-9a-z]+$/);
  });

  it('is unique across rapid calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uid('x')));
    expect(ids.size).toBe(1000);
  });
});
