/**
 * ISO date-string primitives for TEXT datetime columns and doc-wire dates.
 *
 * Fleet schemas split into two worlds: timestamptz columns (drizzle wants a
 * Date — see pickPatch/stampUpdate) and TEXT/date-string columns whose wire
 * format is a truncated ISO string the client renders verbatim. These helpers
 * are the canon for the second world: one precision-parameterized formatter
 * so each domain keeps its historical wire format byte-identical, plus the
 * calendar-day arithmetic (today / base-date shifts) that deadline features
 * keep re-implementing. All UTC — the local-calendar branch inside
 * stampUpdate is the only local-time stamp in the package and stays that way.
 */

export type IsoPrecision = 'ms' | 's' | 'm' | 'd';

const ISO_LENGTH: Record<Exclude<IsoPrecision, 'ms'>, number> = { s: 19, m: 16, d: 10 };

function trunc(iso: string, precision: IsoPrecision): string {
  return precision === 'ms' ? iso : iso.slice(0, ISO_LENGTH[precision]);
}

/** Current instant truncated to the requested precision:
 *  'ms' → 2026-10-18T05:28:47.941Z (full), 's' → …:47, 'm' → …:28, 'd' → 2026-10-18. */
export function isoNow(precision: IsoPrecision = 'ms'): string {
  return trunc(new Date().toISOString(), precision);
}

/** Any instant truncated to the requested precision — the formatter for
 *  stored Dates and computed offsets (`isoAt(new Date(Date.now() + 5 * DAY), 's')`). */
export function isoAt(d: Date, precision: IsoPrecision = 'ms'): string {
  return trunc(d.toISOString(), precision);
}

/** UTC calendar day as 'YYYY-MM-DD' — equals isoNow('d'). */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Day-shifted UTC calendar day from a base date: addDaysISO(base, 3) is
 *  three days out, negative values reach back. Month/year rollovers ride
 *  Date's own calendar math. */
export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
