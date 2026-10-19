import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { ErrorHandler } from 'hono';
import { apiNotFound, spaFallback } from './handlers';
import { apiOnError } from './errors';
import { healthRouter } from './health';
import type { ApiEnv } from './env';

/**
 * The one-call API skeleton — everything the 1.x apps hand-copied into
 * api/index.ts, routes/health.ts and env wiring, composed once:
 *
 *   export default createApi({
 *     service: 'storyora',
 *     build: BUILD_MARKER,
 *     routers: [['/projects', projectsRouter], ['/', orgRouter]],
 *   });
 *
 * The chain, in order: /api/health (canary — deliberately BEFORE middleware
 * so uptime probes stay unauthenticated) → your middleware (auth, logging —
 * /api only) → your routers → onError (the `{ error }` envelope) →
 * unmatched /api/* stays JSON 404 → everything else resolves via the ASSETS
 * binding (SPA). Apps needing a different chain keep hand-mounting the
 * same pieces — this factory is the fleet default, not a cage.
 */
export interface ApiConfig<E extends ApiEnv = ApiEnv> {
  /** Service name surfaced by /api/health. */
  service: string;
  /** CI-injected build marker for the deploy canary; omitted → null. */
  build?: string;
  /** Routers mounted under /api: ['/stories', storiesRouter]. */
  routers?: ReadonlyArray<readonly [string, Hono<{ Bindings: E }>]>;
  /** Middleware applied to the /api sub-app in order (auth, logging…). */
  middleware?: ReadonlyArray<MiddlewareHandler<{ Bindings: E }>>;
}

/** Cap on replayed paths per bootstrap call — keeps one Worker request
 *  inside the free-tier subrequest budget even when a replayed route runs
 *  a couple of queries of its own. */
const BOOTSTRAP_MAX_PATHS = 40;

export function createApi<E extends ApiEnv = ApiEnv>(config: ApiConfig<E>): Hono<{ Bindings: E }> {
  const api = new Hono<{ Bindings: E }>();

  api.route('/health', healthRouter<E>({ service: config.service, build: config.build }));
  for (const mw of config.middleware ?? []) api.use(mw);
  for (const [path, router] of config.routers ?? []) api.route(path, router);

  const app = new Hono<{ Bindings: E }>();
  app.route('/api', api);
  // Widening ApiEnv→E is safe at runtime (c.env: E ⊇ ApiEnv); hono's Context
  // invariance just refuses the direct cast.
  app.onError(apiOnError as unknown as ErrorHandler<{ Bindings: E }>);

  // GET /api/bootstrap?paths=/api/a,/api/b — replays the app's own list
  // routes in-process (no network) and bundles their JSON bodies under one
  // response, so a hydrating client pays one round trip per chunk instead
  // of one per collection. Only /api paths are replayed; anything else the
  // router would have answered stays answerable only the normal way.
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
