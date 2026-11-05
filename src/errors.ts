import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { ApiEnv } from './env';

export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static notFound(label: string): ApiError {
    return new ApiError(404, `${label} not found`);
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, message, details);
  }

  static forbidden(message: string): ApiError {
    return new ApiError(403, message);
  }

  static conflict(message: string): ApiError {
    return new ApiError(409, message);
  }
}

export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e !== null && typeof e === 'object' && depth < 3; depth += 1) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export const apiOnError: ErrorHandler<{ Bindings: ApiEnv }> = (err, c) => {
  if (err instanceof ApiError) {
    return c.json(
      err.details !== undefined ? { error: err.message, details: err.details } : { error: err.message },
      err.status,
    );
  }
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  if (err instanceof ZodError) {
    return c.json({ error: 'Invalid request body', details: err.flatten().fieldErrors }, 400);
  }
  if (isUniqueViolation(err)) {
    return c.json({ error: 'Already exists' }, 409);
  }
  console.error(`[api] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: 'Internal server error' }, 500);
};
