import { Hono } from 'hono';
import type { ApiEnv } from './env';

export function healthRouter<E extends ApiEnv = ApiEnv>(opts: { service: string; build?: string }): Hono<{ Bindings: E }> {
  const router = new Hono<{ Bindings: E }>();
  router.get('/', (c) =>
    c.json({ ok: true, service: opts.service, build: opts.build ?? null, time: new Date().toISOString() }),
  );
  return router;
}
