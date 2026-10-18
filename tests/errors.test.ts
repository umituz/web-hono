import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, apiOnError, isUniqueViolation } from '../src/errors';
import type { ApiEnv } from '../src/env';

/* The onError matrix, exercised through a real Hono app that throws. */

afterEach(() => {
  vi.restoreAllMocks();
});

function throwingApp(onError: typeof apiOnError) {
  const app = new Hono<{ Bindings: ApiEnv }>();
  app.onError(onError);
  app.get('/boom', () => {
    throw new Error('secret db credentials in here');
  });
  app.get('/api-error', () => {
    throw ApiError.notFound('Widget');
  });
  app.get('/zod', () => {
    const parsed = z.object({ name: z.string().min(2) }).safeParse({ name: 'x' });
    throw parsed.error!;
  });
  app.get('/unique', () => {
    const err = new Error('duplicate key value violates unique constraint') as Error & { code: string };
    err.code = '23505';
    throw err;
  });
  app.get('/unique-nested', () => {
    const cause = new Error('duplicate key') as Error & { code: string };
    cause.code = '23505';
    throw new Error('driver wrapped', { cause });
  });
  return app;
}

describe('ApiError', () => {
  it('carries its literal status and message', () => {
    const err = new ApiError(409, 'Conflict', { id: 'x' });
    expect(err.status).toBe(409);
    expect(err.message).toBe('Conflict');
    expect(err.details).toEqual({ id: 'x' });
  });

  it('notFound/badRequest factories speak the fleet shapes', () => {
    expect(ApiError.notFound('Product').message).toBe('Product not found');
    expect(ApiError.notFound('Product').status).toBe(404);
    expect(ApiError.badRequest('No updatable fields').status).toBe(400);
  });
});

describe('isUniqueViolation', () => {
  it('detects the code directly and through a cause chain', () => {
    const direct = new Error('duplicate key') as Error & { code: string };
    direct.code = '23505';
    expect(isUniqueViolation(direct)).toBe(true);
    const nested = new Error('driver wrapped', { cause: direct });
    expect(isUniqueViolation(nested)).toBe(true);
    expect(isUniqueViolation(new Error('other'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe('apiOnError', () => {
  it('maps ApiError to its own status and envelope', async () => {
    const res = await throwingApp(apiOnError).request('/api-error');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Widget not found' });
  });

  it('includes details when present', async () => {
    const app = new Hono<{ Bindings: ApiEnv }>();
    app.onError(apiOnError);
    app.get('/x', () => {
      throw new ApiError(400, 'Bad input', { name: ['required'] });
    });
    const res = await app.request('/x');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Bad input', details: { name: ['required'] } });
  });

  it('maps ZodError to 400 with fieldErrors', async () => {
    const res = await throwingApp(apiOnError).request('/zod');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: Record<string, string[]> };
    expect(body.error).toBe('Invalid request body');
    expect(Object.keys(body.details)).toContain('name');
  });

  it('maps postgres 23505 (direct and nested in a cause chain) to 409', async () => {
    const app = throwingApp(apiOnError);
    expect((await app.request('/unique')).status).toBe(409);
    expect((await app.request('/unique-nested')).status).toBe(409);
    const res = await app.request('/unique');
    expect(await res.json()).toEqual({ error: 'Already exists' });
  });

  it('answers a generic 500 for unexpected errors — never leaking internals', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await throwingApp(apiOnError).request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(logged).toHaveBeenCalledTimes(1); // logged server-side, not leaked
  });
});
