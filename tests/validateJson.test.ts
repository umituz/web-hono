import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { validateJson } from '../src/validator';
import { actorFields, dateOnly, datetimeLocal, datetimeSeconds, hexColor, hhmm } from '../src/validator';

const WidgetSchema = z.object({ name: z.string().trim().min(2), count: z.number().int().min(0) }).strict();

function app() {
  const app = new Hono();
  app.post(
    '/widgets',
    validator('json', validateJson(WidgetSchema, 'Invalid widget payload')),
    (c) => {
      const input = c.req.valid('json');
      // Compile-time seam: input must be the zod OUTPUT type (string name,
      // number count) — if validateJson ever broke hono's inference, this
      // handler stops compiling under strict mode.
      const name: string = input.name;
      return c.json({ received: name, count: input.count });
    },
  );
  return app;
}

function post(body: string) {
  return app().request('/widgets', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
}

describe('validateJson', () => {
  it('rejects invalid bodies with the 400 {error, details} envelope', async () => {
    const res = await post(JSON.stringify({ name: 'x', count: -1 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: Record<string, string[]> };
    expect(body.error).toBe('Invalid widget payload');
    expect(Object.keys(body.details)).toContain('name');
    expect(Object.keys(body.details)).toContain('count');
  });

  it('rejects unknown keys (.strict() contract)', async () => {
    const res = await post(JSON.stringify({ name: 'Gadget', count: 1, extra: true }));
    expect(res.status).toBe(400);
  });

  it('flows parsed (trimmed) data to the handler via c.req.valid', async () => {
    const res = await post(JSON.stringify({ name: '  Gadget  ', count: 3 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 'Gadget', count: 3 });
  });
});

describe('dateOnly', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(dateOnly.safeParse('2026-10-17').success).toBe(true);
    expect(dateOnly.safeParse('0000-01-01').success).toBe(true);
  });

  it('rejects everything else with the expected YYYY-MM-DD message', () => {
    for (const bad of ['2026-10-7', '26-10-17', '17-10-2026', '2026/10/17', '2026-10-17T00:00', '']) {
      const r = dateOnly.safeParse(bad);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]!.message).toBe('expected YYYY-MM-DD');
    }
  });
});

describe('hhmm', () => {
  it('accepts 00:00 through 23:59', () => {
    for (const good of ['00:00', '09:30', '23:59', '13:05']) {
      expect(hhmm.safeParse(good).success).toBe(true);
    }
  });

  it('rejects out-of-range and malformed times with the expected HH:MM message', () => {
    for (const bad of ['24:00', '12:60', '9:30', '0930', '12:5', '']) {
      const r = hhmm.safeParse(bad);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]!.message).toBe('expected HH:MM');
    }
  });
});

describe('datetimeLocal', () => {
  it('accepts date + 00:00–23:59 minute precision', () => {
    for (const good of ['2026-10-17T00:00', '2026-01-31T23:59', '0000-06-15T13:05']) {
      expect(datetimeLocal.safeParse(good).success).toBe(true);
    }
  });

  it('rejects out-of-range times, seconds, and missing pieces with the expected message', () => {
    for (const bad of ['2026-10-17T24:00', '2026-10-17T12:60', '2026-10-17T05:30:00', '2026-10-17 05:30', '2026-10-17T5:30', '2026-10-17', '']) {
      const r = datetimeLocal.safeParse(bad);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]!.message).toBe('expected YYYY-MM-DDTHH:MM');
    }
  });
});

describe('datetimeSeconds', () => {
  it('accepts date + 00:00:00–23:59:59', () => {
    for (const good of ['2026-10-17T00:00:00', '2026-10-17T23:59:59', '1999-12-31T06:07:08']) {
      expect(datetimeSeconds.safeParse(good).success).toBe(true);
    }
  });

  it('rejects minute precision, out-of-range parts, and garbage with the expected message', () => {
    for (const bad of ['2026-10-17T23:59', '2026-10-17T23:59:60', '2026-10-17T24:00:00', '2026-10-17T12:60:00', '2026-10-17T12:00:5', '']) {
      const r = datetimeSeconds.safeParse(bad);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]!.message).toBe('expected YYYY-MM-DDTHH:MM:SS');
    }
  });
});

describe('hexColor', () => {
  it('accepts #RRGGBB in either case', () => {
    for (const good of ['#000000', '#FFFFFF', '#3FaB07', '#ff00cc']) {
      expect(hexColor.safeParse(good).success).toBe(true);
    }
  });

  it('rejects 3-digit, named, unanchored, and malformed colors with the expected message', () => {
    for (const bad of ['#fff', 'ffffff', ' #ffffff', '#ffffff ', '#gggggg', '#12345', '#1234567', '']) {
      const r = hexColor.safeParse(bad);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]!.message).toBe('expected #RRGGBB');
    }
  });
});

describe('actorFields', () => {
  it('spreads into a strict schema: both fields optional, absent ok', () => {
    const Schema = z.object({ note: z.string().min(1), ...actorFields }).strict();
    expect(Schema.safeParse({ note: 'hi' }).success).toBe(true);
    expect(Schema.safeParse({ note: 'hi', actorId: 'usr_1', actorName: 'Ada' })).toEqual({
      success: true,
      data: { note: 'hi', actorId: 'usr_1', actorName: 'Ada' },
    });
    expect(Schema.safeParse({ note: 'hi', actorName: 7 }).success).toBe(false);
    expect(Schema.safeParse({ note: 'hi', extra: 1 }).success).toBe(false); // still strict
  });
});
