import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { verbAction, verbRoutes } from '../src/verb';
import type { VerbContext } from '../src/verb';
import type { ApiEnv } from '../src/env';

interface TestEnv extends ApiEnv {
  SERVICE_NAME: string;
}

const testEnv = {
  DATABASE_URL: 'postgresql://test',
  ASSETS: { fetch: () => Promise.resolve(new Response('asset')) },
  SERVICE_NAME: 'svc',
} as TestEnv;

function makeApp() {
  const app = new Hono<{ Bindings: TestEnv }>();
  let dbCalls = 0;
  const order: string[] = [];
  const sharedDb = (c: VerbContext<TestEnv>) => {
    dbCalls += 1;
    return { label: `${c.req.param('id')}@${c.env.SERVICE_NAME}` };
  };
  app.route(
    '/',
    verbRoutes({
      path: '/widgets/:id/treat',
      json: { schema: z.strictObject({ name: z.string().min(2), status: z.enum(['active', 'retired']).default('active') }), invalid: 'Invalid treatment payload' },
      db: sharedDb,
      handler: ({ input, db }) => Response.json({ input, db }),
    }),
  );
  app.route(
    '/',
    verbAction<TestEnv, string>({
      method: 'delete',
      path: '/widgets/:id',
      db: () => 'db-handle',
      handler: ({ c, db }) => c.json({ id: c.req.param('id'), db }, 200),
    }),
  );
  app.route(
    '/',
    verbRoutes({
      method: 'post',
      path: '/widgets/:id/guarded',
      middlewares: [async (_c, next) => { order.push('middleware'); await next(); }],
      json: { schema: z.strictObject({ pin: z.boolean() }) },
      db: () => 'db-handle',
      handler: ({ input }) => { order.push('handler'); return Response.json({ pinned: input.pin }); },
    }),
  );
  return { app, dbCalls: () => dbCalls, order };
}

describe('verbRoutes', () => {
  it('validates the json body, applies defaults and hands typed input + db + param context', async () => {
    const { app, dbCalls } = makeApp();
    const res = await app.request('/widgets/w1/treat', {
      method: 'POST',
      body: JSON.stringify({ name: 'alpha' }),
      headers: { 'content-type': 'application/json' },
    }, testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { input: { name: string; status: string }; db: { label: string } };
    expect(body.input).toEqual({ name: 'alpha', status: 'active' });
    expect(body.db.label).toBe('w1@svc');
    expect(dbCalls()).toBe(1);
  });

  it('rejects invalid payloads with the custom message and zod details', async () => {
    const { app } = makeApp();
    const res = await app.request('/widgets/w1/treat', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', extra: 1 }),
      headers: { 'content-type': 'application/json' },
    }, testEnv);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: Record<string, string[]> };
    expect(body.error).toBe('Invalid treatment payload');
    expect(Object.keys(body.details).length).toBeGreaterThan(0);
  });

  it('rejects missing or malformed bodies with the same shape', async () => {
    const { app } = makeApp();
    const res = await app.request('/widgets/w1/treat', { method: 'POST' }, testEnv);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid treatment payload');
  });
});

describe('verbAction', () => {
  it('serves bodyless verbs with db and context', async () => {
    const { app } = makeApp();
    const res = await app.request('/widgets/w2', { method: 'DELETE' }, testEnv);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: 'w2', db: 'db-handle' });
  });

  it('defaults to POST', async () => {
    const app = new Hono<{ Bindings: ApiEnv }>();
    app.route('/', verbAction({ path: '/ping', db: () => null, handler: () => Response.json('pong') }));
    const post = await app.request('/ping', { method: 'POST' }, {} as ApiEnv);
    expect(post.status).toBe(200);
    const get = await app.request('/ping', { method: 'GET' }, {} as ApiEnv);
    expect(get.status).toBe(404);
  });

  it('falls back to the shared database factory when db is omitted', async () => {
    const app = new Hono<{ Bindings: ApiEnv }>();
    app.route('/', verbAction({ path: '/ping', handler: ({ db }) => Response.json(String(typeof db.select === 'function')) }));
    const res = await app.request('/ping', { method: 'POST' }, testEnv);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toBe('true');
  });

  it('runs custom middlewares ahead of validation and the handler', async () => {
    const { app, order } = makeApp();
    const res = await app.request('/widgets/w3/guarded', {
      method: 'POST',
      body: JSON.stringify({ pin: true }),
      headers: { 'content-type': 'application/json' },
    }, testEnv);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ pinned: true });
    expect(order).toEqual(['middleware', 'handler']);
  });
});
