export type IsoPrecision = 'ms' | 's' | 'm' | 'd';

const ISO_LENGTH: Record<Exclude<IsoPrecision, 'ms'>, number> = { s: 19, m: 16, d: 10 };

function trunc(iso: string, precision: IsoPrecision): string {
  return precision === 'ms' ? iso : iso.slice(0, ISO_LENGTH[precision]);
}

export function isoNow(precision: IsoPrecision = 'ms'): string {
  return trunc(new Date().toISOString(), precision);
}

export function isoAt(d: Date, precision: IsoPrecision = 'ms'): string {
  return trunc(d.toISOString(), precision);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
