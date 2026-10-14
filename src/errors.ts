import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { ApiEnv } from './env';

/**
 * The error layer of the `{ error, details? }` envelope. Routes throw
 * `ApiError` (or let drizzle/postgres errors bubble) and `apiOnError` —
 * installed by `createApi`, or by hand via `app.onError(apiOnError)` —
 * maps everything to the envelope. Unexpected errors never leak internals:
 * they answer a generic 500 and log server-side.
 */

/** A deliberate 4xx: the route's own words, the envelope's shape. */
export class ApiError extends Error {
  constructor(
    /** Literal status this error answers with (404, 400, 409…). */
    public readonly status: ContentfulStatusCode,
    message: string,
    /** Optional details (zod fieldErrors, ids, …). */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** `404 { error: '${label} not found' }` — the fleet's miss shape. */
  static notFound(label: string): ApiError {
    return new ApiError(404, `${label} not found`);
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, message, details);
  }
}

/**
 * Postgres unique_violation — the code sits on the error itself (pglite,
 * node-postgres) or nested in a driver cause-chain (neon-http). Depth-capped
 * walk so malformed causes can't loop.
 */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e !== null && typeof e === 'object' && depth < 3; depth += 1) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** The standard onError: every failure speaks the envelope. */
export const apiOnError: ErrorHandler<{ Bindings: ApiEnv }> = (err, c) => {
  if (err instanceof ApiError) {
    return c.json(
      err.details !== undefined ? { error: err.message, details: err.details } : { error: err.message },
      err.status,
    );
  }
  if (err instanceof ZodError) {
    // Safety net: validateJson normally answers inline, but a hand-rolled
    // safeParse that throws lands here with the same contract.
    return c.json({ error: 'Invalid request body', details: err.flatten().fieldErrors }, 400);
  }
  if (isUniqueViolation(err)) {
    return c.json({ error: 'Already exists' }, 409);
  }
  // Unexpected: log server-side, answer generic — never leak internals.
  console.error(`[api] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: 'Internal server error' }, 500);
};
