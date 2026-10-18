import { describe, expect, it } from 'vitest';
import { addDaysISO, isoNow, todayISO } from '../src/dates';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

describe('isoNow precision', () => {
  it('defaults to the full millisecond ISO string', () => {
    expect(isoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("truncates to seconds — notaria's wire format", () => {
    expect(isoNow('s')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it("truncates to minutes — influencera's wire format", () => {
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

describe('todayISO', () => {
  it('is the UTC calendar day, identical to isoNow("d")', () => {
    expect(todayISO()).toMatch(DAY);
    expect(todayISO()).toBe(isoNow('d'));
  });
});

describe('addDaysISO', () => {
  it('returns a calendar-day string', () => {
    expect(addDaysISO(7)).toMatch(DAY);
  });

  it('moves exactly N days away from today', () => {
    const base = Date.parse(`${todayISO()}T00:00:00Z`);
    expect(Date.parse(`${addDaysISO(3)}T00:00:00Z`)).toBe(base + 3 * 86_400_000);
    expect(Date.parse(`${addDaysISO(-3)}T00:00:00Z`)).toBe(base - 3 * 86_400_000);
  });

  it('rolls over months and years via UTC calendar math', () => {
    const base = Date.parse(`${todayISO()}T00:00:00Z`);
    expect(Date.parse(`${addDaysISO(45)}T00:00:00Z`)).toBe(base + 45 * 86_400_000);
    expect(Date.parse(`${addDaysISO(400)}T00:00:00Z`)).toBe(base + 400 * 86_400_000);
  });
});
