/**
 * ISO date-string primitives for TEXT datetime columns and doc-wire dates.
 *
 * Fleet schemas split into two worlds: timestamptz columns (drizzle wants a
 * Date — see pickPatch/stampUpdate) and TEXT/date-string columns whose wire
 * format is a truncated ISO string the client renders verbatim. These helpers
 * are the canon for the second world: one `isoNow` with explicit precision so
 * each domain keeps its historical wire format byte-identical, plus the
 * calendar-day arithmetic (today / addDays) that deadline features keep
 * re-implementing. All UTC — the local-calendar branch inside stampUpdate is
 * the only local-time stamp in the package and stays that way.
 */

export type IsoPrecision = 'ms' | 's' | 'm' | 'd';

const ISO_LENGTH: Record<Exclude<IsoPrecision, 'ms'>, number> = { s: 19, m: 16, d: 10 };

/** Current instant as an ISO string truncated to the requested precision:
 *  'ms' → 2026-10-18T05:28:47.941Z (full), 's' → …:47, 'm' → …:28, 'd' → 2026-10-18. */
export function isoNow(precision: IsoPrecision = 'ms'): string {
  const iso = new Date().toISOString();
  return precision === 'ms' ? iso : iso.slice(0, ISO_LENGTH[precision]);
}

/** UTC calendar day as 'YYYY-MM-DD' — equals isoNow('d'). */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Day-shifted UTC calendar day: addDaysISO(3) is three days out, negative
 *  values reach back. Month/year rollovers ride Date's own calendar math. */
export function addDaysISO(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
