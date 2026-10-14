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
  app.all('/api/*', apiNotFound);
  app.get('*', spaFallback);
  return app;
}
