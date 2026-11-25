import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  nonNegativeInt,
  paginationQuery,
  positiveInt,
  slug,
  uuid,
  zBody,
  zLooseBody,
  zParam,
  zQuery,
  zStrictBody,
} from '../src/validator';

describe('validator middleware helpers', () => {
  it('zBody validates valid JSON payload', async () => {
    const app = new Hono();
    const schema = z.object({ name: z.string().min(2) });
    app.post('/items', zBody(schema), (c) => c.json(c.req.valid('json')));

    const res = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Valid Item' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Valid Item' });
  });

  it('zBody rejects invalid JSON payload with 400', async () => {
    const app = new Hono();
    const schema = z.object({ name: z.string().min(2) });
    app.post('/items', zBody(schema, 'Custom error message'), (c) => c.json(c.req.valid('json')));

    const res = await app.request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: { name: string[] } };
    expect(body.error).toBe('Custom error message');
    expect(body.details.name).toBeDefined();
  });

  it('zStrictBody forbids unexpected fields', async () => {
    const app = new Hono();
    app.post('/strict', zStrictBody({ title: z.string() }), (c) => c.json(c.req.valid('json')));

    const res = await app.request('/strict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Strict Title', extra: 'forbidden' }),
    });
    expect(res.status).toBe(400);
  });

  it('zLooseBody allows extra fields', async () => {
    const app = new Hono();
    app.post('/loose', zLooseBody({ title: z.string() }), (c) => c.json(c.req.valid('json')));

    const res = await app.request('/loose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Loose Title', extra: 'allowed' }),
    });
    expect(res.status).toBe(200);
  });

  it('zQuery validates query parameters', async () => {
    const app = new Hono();
    const querySchema = z.object({ search: z.string().min(1) });
    app.get('/search', zQuery(querySchema), (c) => c.json(c.req.valid('query')));

    const resValid = await app.request('/search?search=art');
    expect(resValid.status).toBe(200);
    expect(await resValid.json()).toEqual({ search: 'art' });

    const resInvalid = await app.request('/search');
    expect(resInvalid.status).toBe(400);
  });

  it('zParam validates path parameters', async () => {
    const app = new Hono();
    const paramSchema = z.object({ id: z.string().min(3) });
    app.get('/items/:id', zParam(paramSchema), (c) => c.json(c.req.valid('param')));

    const resValid = await app.request('/items/art-123');
    expect(resValid.status).toBe(200);
    expect(await resValid.json()).toEqual({ id: 'art-123' });

    const resInvalid = await app.request('/items/a');
    expect(resInvalid.status).toBe(400);
  });
});

describe('common zod schemas', () => {
  it('uuid schema checks valid UUID', () => {
    expect(uuid.safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(true);
    expect(uuid.safeParse('invalid-uuid').success).toBe(false);
  });

  it('slug schema checks kebab-case', () => {
    expect(slug.safeParse('valid-slug-123').success).toBe(true);
    expect(slug.safeParse('Invalid Slug').success).toBe(false);
  });

  it('positiveInt and nonNegativeInt coerce strings', () => {
    expect(positiveInt.parse('42')).toBe(42);
    expect(positiveInt.safeParse('0').success).toBe(false);
    expect(nonNegativeInt.parse('0')).toBe(0);
  });

  it('paginationQuery parses and defaults values', () => {
    expect(paginationQuery.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(paginationQuery.parse({ page: '3', pageSize: '50' })).toEqual({ page: 3, pageSize: 50 });
  });
});
