import { describe, expect, it } from 'vitest';
import { addDaysISO, isoAt, isoNow, todayISO } from '../src/dates';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

describe('isoNow precision', () => {
  it('defaults to the full millisecond ISO string', () => {
    expect(isoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("truncates to seconds — notaria's wire format", () => {
    expect(isoNow('s')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it("truncates to minutes — merchora's wire format", () => {
    expect(isoNow('m')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('truncates to the UTC calendar day', () => {
    expect(isoNow('d')).toMatch(DAY);
  });

  it('keeps truncations consistent prefixes of the same instant', () => {
    const full = isoNow();
    expect(isoNow('s').startsWith(full.slice(0, 16))).toBe(true);
    expect(isoNow('d')).toBe(full.slice(0, 10));
  });
});

describe('isoAt', () => {
  it('formats an arbitrary instant with the same precision contract', () => {
    const d = new Date('2026-10-18T05:28:47.941Z');
    expect(isoAt(d)).toBe('2026-10-18T05:28:47.941Z');
    expect(isoAt(d, 's')).toBe('2026-10-18T05:28:47');
    expect(isoAt(d, 'm')).toBe('2026-10-18T05:28');
    expect(isoAt(d, 'd')).toBe('2026-10-18');
  });

  it('covers the fleet offset pattern — now + N days, seconds precision', () => {
    const expected = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 19);
    expect(isoAt(new Date(Date.now() + 5 * 86_400_000), 's')).toBe(expected);
  });
});

describe('todayISO', () => {
  it('is the UTC calendar day, identical to isoNow("d")', () => {
    expect(todayISO()).toMatch(DAY);
    expect(todayISO()).toBe(isoNow('d'));
  });
});

describe('addDaysISO', () => {
  it('returns a calendar-day string', () => {
    expect(addDaysISO(todayISO(), 7)).toMatch(DAY);
  });

  it('shifts a base date exactly N days', () => {
    expect(addDaysISO('2026-10-18', 3)).toBe('2026-10-21');
    expect(addDaysISO('2026-10-18', -3)).toBe('2026-10-15');
  });

  it('rolls over months and years via UTC calendar math', () => {
    expect(addDaysISO('2026-10-28', 45)).toBe('2026-12-12');
    expect(addDaysISO('2026-12-28', 400)).toBe('2028-02-01');
    expect(addDaysISO('2024-02-27', 3)).toBe('2024-03-01');
  });

  it('ignores any time component a wire date drags along', () => {
    expect(addDaysISO('2026-10-18T05:28:47.941Z', 1)).toBe('2026-10-19');
  });
});
