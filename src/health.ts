import { Hono } from 'hono';
import type { ApiEnv } from './env';

/**
 * The deploy canary: `GET /api/health` → `{ ok, service, build, time }`.
 * `build` is the CI-injected marker (missing → null) — bump it so the E2E
 * canary can prove the new Worker is the one answering. Replaces the
 * per-app routes/health.ts that 1.x apps copied around verbatim.
 */
export function healthRouter<E extends ApiEnv = ApiEnv>(opts: { service: string; build?: string }): Hono<{ Bindings: E }> {
  const router = new Hono<{ Bindings: E }>();
  router.get('/', (c) =>
    c.json({ ok: true, service: opts.service, build: opts.build ?? null, time: new Date().toISOString() }),
  );
  return router;
}
