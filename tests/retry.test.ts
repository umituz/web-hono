import { describe, expect, it, vi } from 'vitest';
import { mapLimit, withRetry } from '../src/lib';

describe('withRetry', () => {
  it('returns on the first success without delay', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries until success', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('flaky');
      return 'recovered';
    });
    await expect(withRetry(fn)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting attempts', async () => {
    const fn = vi.fn(async () => {
      throw new Error('always down');
    });
    await expect(withRetry(fn, 2)).rejects.toThrow('always down');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('mapLimit', () => {
  it('maps every item in waves of the limit', async () => {
    let active = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6, 7];
    const out = await mapLimit(items, 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 5, async (n) => n)).toEqual([]);
  });
});
