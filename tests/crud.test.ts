import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { crudRoutes, listRoutes } from '../src/crud';
import { stampUpdate } from '../src/lib';
import { apiNotFound, spaFallback } from '../src/handlers';
import type { ApiEnv } from '../src/env';
import { journals, widgets } from './helpers';

/** Minimal table WITHOUT the fleet time trio — stamps nothing, never 500s. */
const bare = pgTable('wh_bare', { id: text('id').primaryKey() });

const crudSchema = z.object({ name: z.string() }).strict();

/* GET/PATCH success paths need a live Neon DB — they are proven by the
 * consuming app's E2E. Covered here: the paths that
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

  it('PATCH with a non-JSON body answers the malformed-JSON envelope, not 500', async () => {
    const res = await crudApp().request('/api/widgets/w_1', { method: 'PATCH', body: 'not json' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Malformed JSON in request body' });
  });

  it('PATCH with a value contradicting the column type answers 400 with details', async () => {
    const res = await crudApp().request('/api/widgets/w_1', {
      method: 'PATCH',
      body: JSON.stringify({ count: 'abc', name: 7 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Invalid field types',
      details: { count: ['expected number'], name: ['expected string'] },
    });
  });

  it('PATCH with fitting types passes the type gate (unchanged envelope on miss)', async () => {
    const res = await crudApp().request('/api/ghosts/w_1', {
      method: 'PATCH',
      body: JSON.stringify({ count: 3 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });
});

describe('crudRoutes create', () => {
  it('POST with a non-JSON body answers the malformed-JSON envelope, not Invalid request body', async () => {
    const app = new Hono<{ Bindings: ApiEnv }>();
    app.route(
      '/api',
      crudRoutes({
        path: '/widgets',
        table: widgets,
        label: 'Widget',
        create: { schema: crudSchema, prefix: 'wid' },
      }),
    );
    const res = await app.request('/api/widgets', { method: 'POST', body: '{"name": ' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Malformed JSON in request body' });
  });
});

describe('listRoutes', () => {
  it('mounts no write surface — PATCH falls through to 404', async () => {
    const app = new Hono<{ Bindings: ApiEnv }>();
    app.route('/api', listRoutes({ path: '/journals', table: journals, orderBy: { col: journals.createdAt } }));
    const res = await app.request('/api/journals/j_1', { method: 'PATCH', body: JSON.stringify({ note: 'x' }) });
    expect(res.status).toBe(404);
  });
});

describe('stampUpdate', () => {
  it('stamps a Date for timestamp updatedAt columns (fleet standard, unchanged)', () => {
    const stamp = stampUpdate(widgets);
    expect(stamp.updatedAt).toBeInstanceOf(Date);
  });

  it("stamps today's 'YYYY-MM-DD' for date-string updatedAt columns", () => {
    const stamp = stampUpdate(journals);
    expect(stamp.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof stamp.updatedAt).toBe('string');
  });

  it('stamps nothing when the table has no updatedAt column', () => {
    expect(stampUpdate(bare)).toEqual({});
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
