import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { crudRoutes } from '../src/crud';
import { apiNotFound, spaFallback } from '../src/handlers';
import type { ApiEnv } from '../src/env';
import { widgets } from './helpers';

/* GET/PATCH success paths need a live Neon DB — they are proven by the
 * consuming app's E2E (pilot: foodora). Covered here: the paths that
 * short-circuit BEFORE any DB call, plus the two app-closing handlers. */

function crudApp() {
  const app = new Hono<{ Bindings: ApiEnv }>();
  app.route('/api', crudRoutes({ path: '/widgets', table: widgets, label: 'Widget' }));
  return app;
}

describe('crudRoutes', () => {
  it('PATCH with no updatable fields answers 400 before touching the DB', async () => {
    const res = await crudApp().request('/api/widgets/w_1', {
      method: 'PATCH',
      body: JSON.stringify({ id: 'w_1', updatedAt: '2026-01-01T00:00:00Z' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No updatable fields' });
  });

  it('PATCH with a non-JSON body answers 400, not 500', async () => {
    const res = await crudApp().request('/api/widgets/w_1', { method: 'PATCH', body: 'not json' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No updatable fields' });
  });
});

describe('apiNotFound', () => {
  it('keeps unmatched /api/* paths JSON 404', async () => {
    const app = new Hono<{ Bindings: ApiEnv }>();
    app.all('/api/*', apiNotFound);
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});

describe('spaFallback', () => {
  it('forwards the ORIGINAL request to the ASSETS binding', async () => {
    const seen: Request[] = [];
    const env = {
      DATABASE_URL: '',
      ASSETS: {
        fetch: async (req: Request) => {
          seen.push(req);
          return new Response('<!doctype html><title>spa</title>', { headers: { 'content-type': 'text/html' } });
        },
      },
    };
    const app = new Hono<{ Bindings: ApiEnv }>();
    app.get('*', spaFallback);
    const res = await app.request('/suppliers', undefined, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('spa');
    expect(seen[0]?.url.endsWith('/suppliers')).toBe(true);
  });
});
