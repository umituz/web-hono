import type { Handler } from 'hono';
import type { ApiEnv } from './env';

/**
 * Unmatched API paths must stay JSON — without this they'd fall into the
 * SPA fallback and return index.html with a 200.
 * Usage: `app.all('/api/*', apiNotFound)`.
 */
export const apiNotFound: Handler<{ Bindings: ApiEnv }> = (c) => c.json({ error: 'Not found' }, 404);

/**
 * SPA fallback: client-side routes (e.g. /suppliers) have no asset file.
 * Pass the ORIGINAL request to the assets binding — with
 * `not_found_handling: "single-page-application"` it resolves to index.html
 * in place (no redirect). Fetching "/index.html" explicitly would 307 to "/".
 * Usage: `app.get('*', spaFallback)`.
 */
export const spaFallback: Handler<{ Bindings: ApiEnv }> = (c) => c.env.ASSETS.fetch(c.req.raw);
