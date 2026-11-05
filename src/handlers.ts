import type { Handler } from 'hono';
import type { ApiEnv } from './env';

export const apiNotFound: Handler<{ Bindings: ApiEnv }> = (c) => c.json({ error: 'Not found' }, 404);

export const spaFallback: Handler<{ Bindings: ApiEnv }> = (c) => c.env.ASSETS.fetch(c.req.raw);
