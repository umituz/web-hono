import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { createApi } from '../src/api';
import { ApiError } from '../src/errors';
import { internalError } from '../src/http';
import { validateJson } from '../src/validator';
import type { ApiEnv } from '../src/env';

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

  it('runs middleware on the health canary too', async () => {
    const { app, seen } = makeApp();
    await app.request('/api/health', undefined, env);
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

  it('bundles replayed /api list routes under GET /api/bootstrap', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/bootstrap?paths=/api/things,/api/things', undefined, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: { '/api/things': { status: 200, body: [{ id: 't_1' }] } },
    });
  });

  it('ignores non-/api paths, duplicates and its own route in the bootstrap list', async () => {
    const { app } = makeApp();
    const res = await app.request(`/api/bootstrap?paths=${encodeURIComponent('https://evil.example')},/api/bootstrap,,/api/health`, undefined, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Record<string, unknown> };
    expect(Object.keys(body.results)).toEqual(['/api/health']);
    expect(body.results['/api/health']).toMatchObject({ status: 200 });
  });

  it('reports a non-200 replay status without a body, keeping the error envelope shape', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/bootstrap?paths=/api/things/gone,/api/nope', undefined, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: {
        '/api/things/gone': { status: 404 },
        '/api/nope': { status: 404 },
      },
    });
  });

  it('runs middleware on the bootstrap request and on every replayed path', async () => {
    const { app, seen } = makeApp();
    await app.request('/api/bootstrap?paths=/api/things', undefined, env);
    expect(seen).toEqual(['mw1', 'mw1']);
  });

  it('notifies onError sink with error details when an endpoint throws', async () => {
    const sink = vi.fn();
    const subRouter = new Hono<{ Bindings: ApiEnv }>();
    subRouter.get('/fail', () => {
      throw new Error('boom');
    });

    const app = createApi<ApiEnv>({
      service: 'test-api',
      routers: [['/test', subRouter]],
      onError: sink,
    });

    const res = await app.request('/api/test/fail', undefined, env);
    expect(res.status).toBe(500);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/api/test/fail',
        status: 500,
        message: 'boom',
      }),
      env,
    );
  });

  it('notifies onError sink once for a thrown error and not again for its response', async () => {
    const sink = vi.fn();
    const subRouter = new Hono<{ Bindings: ApiEnv }>();
    subRouter.get('/fail', () => {
      throw new Error('boom');
    });

    const app = createApi<ApiEnv>({
      service: 'test-api',
      routers: [['/test', subRouter]],
      onError: sink,
    });

    await app.request('/api/test/fail', undefined, env);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('notifies onError sink when a handler returns a 5xx response', async () => {
    const sink = vi.fn();
    const subRouter = new Hono<{ Bindings: ApiEnv }>();
    subRouter.get('/fail', (c) => internalError(c, 'Failed to fetch users'));

    const app = createApi<ApiEnv>({
      service: 'test-api',
      routers: [['/test', subRouter]],
      onError: sink,
    });

    const res = await app.request('/api/test/fail', undefined, env);
    expect(res.status).toBe(500);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/api/test/fail',
        status: 500,
        message: 'Failed to fetch users',
      }),
      env,
    );
    expect(await res.json()).toEqual({ error: 'Failed to fetch users', details: 'error' });
  });

  it('notifies onError sink for returned 503 responses but not for 4xx responses', async () => {
    const sink = vi.fn();
    const subRouter = new Hono<{ Bindings: ApiEnv }>();
    subRouter.get('/unavailable', (c) => c.json({ error: 'billing_not_configured' }, 503));
    subRouter.get('/bad', (c) => c.json({ error: 'nope' }, 400));

    const app = createApi<ApiEnv>({
      service: 'test-api',
      routers: [['/test', subRouter]],
      onError: sink,
    });

    expect((await app.request('/api/test/bad', undefined, env)).status).toBe(400);
    expect(sink).not.toHaveBeenCalled();
    expect((await app.request('/api/test/unavailable', undefined, env)).status).toBe(503);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503, message: 'billing_not_configured' }),
      env,
    );
  });
});

describe('createApi security wiring', () => {
  it('applies default security headers on api routes when security: true', async () => {
    const app = createApi<ApiEnv>({ service: 'sec', security: true });
    const res = await app.request('/api/health', undefined, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();
  });

  it('leaves responses untouched when security is not configured', async () => {
    const app = createApi<ApiEnv>({ service: 'sec' });
    const res = await app.request('/api/health', undefined, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    expect(res.headers.get('X-Frame-Options')).toBeNull();
  });

  it('passes custom csp directives through and merges with defaults', async () => {
    const app = createApi<ApiEnv>({
      service: 'sec',
      security: { csp: { styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'] } },
    });
    const res = await app.request('/api/health', undefined, env);
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' data: https://fonts.gstatic.com");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp.indexOf('https://fonts.googleapis.com')).toBe(csp.lastIndexOf('https://fonts.googleapis.com'));
  });

  it('can disable the csp while keeping the other headers', async () => {
    const app = createApi<ApiEnv>({ service: 'sec', security: { csp: false } });
    const res = await app.request('/api/health', undefined, env);
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('sets hsts only on https requests', async () => {
    const app = createApi<ApiEnv>({ service: 'sec', security: { hsts: true } });
    const http = await app.request('http://x/api/health', undefined, env);
    expect(http.headers.get('Strict-Transport-Security')).toBeNull();
    const https = await app.request('https://x/api/health', undefined, env);
    expect(https.headers.get('Strict-Transport-Security')).toContain('max-age=');
  });
});
