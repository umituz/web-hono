import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { ApiError, apiOnError } from '../src/errors';
import type { ApiEnv } from '../src/env';

describe('ApiError factory methods', () => {
  it('instantiates unauthorized with 401', () => {
    const err = ApiError.unauthorized('Custom 401');
    expect(err.status).toBe(401);
    expect(err.message).toBe('Custom 401');
  });

  it('instantiates unprocessable with 422', () => {
    const err = ApiError.unprocessable('Validation failed', { field: 'name' });
    expect(err.status).toBe(422);
    expect(err.message).toBe('Validation failed');
    expect(err.details).toEqual({ field: 'name' });
  });

  it('instantiates tooManyRequests with 429', () => {
    const err = ApiError.tooManyRequests();
    expect(err.status).toBe(429);
    expect(err.message).toBe('Too many requests');
  });
});

describe('apiOnError error handling', () => {
  it('handles NotFoundError with 404 and NOT_FOUND code', async () => {
    const app = new Hono<{ Bindings: ApiEnv }>();
    app.onError(apiOnError);
    app.get('/test', () => {
      const err = new Error('Artwork not found');
      err.name = 'NotFoundError';
      (err as unknown as { code: string }).code = 'NOT_FOUND';
      throw err;
    });

    const res = await app.request('/test');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Artwork not found', code: 'NOT_FOUND' });
  });

  it('handles custom errors with status property', async () => {
    const app = new Hono<{ Bindings: ApiEnv }>();
    app.onError(apiOnError);
    app.get('/test', () => {
      const err = new Error('Payment required');
      (err as unknown as { status: number }).status = 402;
      throw err;
    });

    const res = await app.request('/test');
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'Payment required' });
  });

  it('handles ApiError with status and details', async () => {
    const app = new Hono<{ Bindings: ApiEnv }>();
    app.onError(apiOnError);
    app.get('/test', () => {
      throw ApiError.unauthorized('Invalid bearer token');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid bearer token' });
  });
});
