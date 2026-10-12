import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { validateJson } from '../src/validator';

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
