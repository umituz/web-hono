import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { ErrorHandler } from 'hono';
import { apiNotFound, spaFallback } from './handlers';
import { apiOnError } from './errors';
import { healthRouter } from './health';
import type { ApiEnv } from './env';

export interface ApiConfig<E extends ApiEnv = ApiEnv> {
  service: string;
  build?: string;
  routers?: ReadonlyArray<readonly [string, Hono<{ Bindings: E }>]>;
  middleware?: ReadonlyArray<MiddlewareHandler<{ Bindings: E }>>;
}

const BOOTSTRAP_MAX_PATHS = 40;

export function createApi<E extends ApiEnv = ApiEnv>(config: ApiConfig<E>): Hono<{ Bindings: E }> {
  const api = new Hono<{ Bindings: E }>();

  api.route('/health', healthRouter<E>({ service: config.service, build: config.build }));
  for (const mw of config.middleware ?? []) api.use(mw);
  for (const [path, router] of config.routers ?? []) api.route(path, router);

  const app = new Hono<{ Bindings: E }>();
  app.route('/api', api);
  app.onError(apiOnError as unknown as ErrorHandler<{ Bindings: E }>);

  app.get('/api/bootstrap', async (c) => {
    const raw = c.req.query('paths') ?? '';
    const paths = [...new Set(raw.split(',').map((p) => p.trim()).filter((p) => p.startsWith('/api/') && p !== '/api/bootstrap'))]
      .slice(0, BOOTSTRAP_MAX_PATHS);
    const results: Record<string, { status: number; body?: unknown }> = {};
    await Promise.all(
      paths.map(async (p) => {
        const res = await app.request(p, { headers: c.req.raw.headers }, c.env);
        if (res.status !== 200) {
          results[p] = { status: res.status };
          return;
        }
        const body = await res.json().catch(() => undefined);
        results[p] = body === undefined ? { status: res.status } : { status: res.status, body };
      }),
    );
    return c.json({ results });
  });

  app.all('/api/*', apiNotFound);
  app.get('*', spaFallback);
  return app;
}
