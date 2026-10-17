import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { createApi } from '../src/api';
import { ApiError } from '../src/errors';
import { validateJson } from '../src/validator';
import type { ApiEnv } from '../src/env';

/* The skeleton, exercised as a full Worker app: health, mounts, middleware
 * order, the JSON-404/SPA boundary, and the onError envelope. */

const env: ApiEnv = {
  DATABASE_URL: '',
  ASSETS: { fetch: async () => new Response('<!doctype html><title>spa</title>', { headers: { 'content-type': 'text/html' } }) },
};

function makeApp() {
  const seen: string[] = [];
  const app = createApi<ApiEnv>({
    service: 'test-api',
    build: 'test-1',
    middleware: [
      async (_c, next) => {
        seen.push('mw1');
        await next();
      },
    ],
    routers: [
      [
        '/things',
        (() => {
          const r = new Hono<{ Bindings: ApiEnv }>();
          r.get('/', (c) => c.json([{ id: 't_1' }]));
          r.get('/gone', () => {
            throw ApiError.notFound('Thing');
          });
          return r;
        })(),
      ],
    ],
  });
  return { app, seen };
}

describe('createApi', () => {
  it('serves the health canary with service and build marker', async () => {
    const res = await makeApp().app.request('/api/health', undefined, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string; build: string | null; time: string };
    expect(body).toMatchObject({ ok: true, service: 'test-api', build: 'test-1' });
    expect(typeof body.time).toBe('string');
  });

  it('reports build: null when no marker given', async () => {
    const app = createApi<ApiEnv>({ service: 'x' });
    const res = await app.request('/api/health', undefined, env);
    const body = (await res.json()) as { build: string | null };
    expect(body.build).toBeNull();
  });

  it('mounts routers under /api', async () => {
    const res = await makeApp().app.request('/api/things', undefined, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 't_1' }]);
  });

  it('runs middleware before the routers', async () => {
    const { app, seen } = makeApp();
    await app.request('/api/things', undefined, env);
    expect(seen).toEqual(['mw1']);
  });

  it('keeps unmatched /api/* paths JSON 404 — never the SPA', async () => {
    const res = await makeApp().app.request('/api/nope', undefined, env);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('resolves non-API GETs through the ASSETS binding (SPA)', async () => {
    const res = await makeApp().app.request('/some/client/route', undefined, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('spa');
  });

  it('maps thrown ApiErrors to the envelope via onError', async () => {
    const res = await makeApp().app.request('/api/things/gone', undefined, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Thing not found' });
  });

  it('maps hono HTTPException (malformed JSON body) to the envelope as 400', async () => {
    const app = createApi<ApiEnv>({
      service: 'x',
      routers: [['/things', (() => {
        const r = new Hono<{ Bindings: ApiEnv }>();
        r.post('/', validator('json', validateJson(z.object({ name: z.string() }).strict(), 'Invalid thing payload')), (c) => c.json(c.req.valid('json'), 201));
        return r;
      })()]],
    });
    const res = await app.request('/api/things', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name": ' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Malformed JSON in request body' });
  });

  it('answers a generic 500 (no leak) for unexpected throws, and logs', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApi<ApiEnv>({
      service: 'x',
      routers: [['/boom', (() => {
        const r = new Hono<{ Bindings: ApiEnv }>();
        r.get('/', () => {
          throw new Error('very secret internals');
        });
        return r;
      })()]],
    });
    const res = await app.request('/api/boom', undefined, env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(logged).toHaveBeenCalledOnce();
  });
});
