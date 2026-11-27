import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { createDb } from '@umituz/web-database';
import type { Db } from '@umituz/web-database';
import { z } from 'zod';
import type { ApiEnv } from './env';

export type VerbMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type VerbContext<E extends ApiEnv = ApiEnv> = Context<{ Bindings: E }>;

export interface VerbJsonSpec<S extends z.ZodType> {
  schema: S;
  invalid?: string;
}

export interface VerbSpec<E extends ApiEnv = ApiEnv, D = Db, S extends z.ZodType = z.ZodType> {
  method?: VerbMethod;
  path: string;
  middlewares?: ReadonlyArray<MiddlewareHandler<{ Bindings: E }>>;
  json: VerbJsonSpec<S>;
  db?: (c: VerbContext<E>) => D;
  handler: (args: { c: VerbContext<E>; input: z.output<S>; db: D }) => Response | Promise<Response>;
}

export interface VerbActionSpec<E extends ApiEnv = ApiEnv, D = Db> {
  method?: VerbMethod;
  path: string;
  middlewares?: ReadonlyArray<MiddlewareHandler<{ Bindings: E }>>;
  db?: (c: VerbContext<E>) => D;
  handler: (args: { c: VerbContext<E>; db: D }) => Response | Promise<Response>;
}

type VerbRegistrar = (path: string, ...handlers: MiddlewareHandler<{ Bindings: ApiEnv }>[]) => void;

function defaultDb(c: VerbContext): Db {
  return createDb(c.env.DATABASE_URL);
}

function registerVerb(
  router: Hono<{ Bindings: ApiEnv }>,
  method: VerbMethod,
  path: string,
  specMiddlewares: ReadonlyArray<MiddlewareHandler> | undefined,
  run: (c: VerbContext) => Promise<Response>,
): void {
  const middlewares = (specMiddlewares ?? []) as ReadonlyArray<MiddlewareHandler<{ Bindings: ApiEnv }>>;
  (router[method] as unknown as VerbRegistrar)(path, ...middlewares, run);
}

export function verbRoutes<E extends ApiEnv = ApiEnv, D = Db, S extends z.ZodType = z.ZodType>(
  spec: VerbSpec<E, D, S>,
): Hono<{ Bindings: E }> {
  const typed = spec as unknown as VerbSpec<ApiEnv, unknown, S>;
  const router = new Hono<{ Bindings: ApiEnv }>();
  registerVerb(router, spec.method ?? 'post', spec.path, spec.middlewares, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = spec.json.schema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: spec.json.invalid ?? 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        400,
      );
    }
    const db = typed.db ? typed.db(c) : defaultDb(c);
    return typed.handler({ c, input: parsed.data, db });
  });
  return router as unknown as Hono<{ Bindings: E }>;
}

export function verbAction<E extends ApiEnv = ApiEnv, D = Db>(
  spec: VerbActionSpec<E, D>,
): Hono<{ Bindings: E }> {
  const typed = spec as unknown as VerbActionSpec<ApiEnv, unknown>;
  const router = new Hono<{ Bindings: ApiEnv }>();
  registerVerb(router, spec.method ?? 'post', spec.path, spec.middlewares, async (c) => {
    const db = typed.db ? typed.db(c) : defaultDb(c);
    return typed.handler({ c, db });
  });
  return router as unknown as Hono<{ Bindings: E }>;
}
