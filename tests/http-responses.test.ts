import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  badRequest,
  conflict,
  created,
  extractBearerToken,
  forbidden,
  noContent,
  notFound,
  ok,
  parsePagination,
  unauthorized,
} from '../src/http';

describe('http response helpers', () => {
  it('ok returns 200 with JSON payload', async () => {
    const app = new Hono();
    app.get('/test', (c) => ok(c, { message: 'hello' }));
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'hello' });
  });

  it('created returns 201 with JSON payload', async () => {
    const app = new Hono();
    app.post('/test', (c) => created(c, { id: '123' }));
    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: '123' });
  });

  it('noContent returns 204 with empty body', async () => {
    const app = new Hono();
    app.delete('/test', (c) => noContent(c));
    const res = await app.request('/test', { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('badRequest returns 400 with error and details', async () => {
    const app = new Hono();
    app.get('/test', (c) => badRequest(c, 'Invalid payload', { field: 'missing' }));
    const res = await app.request('/test');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid payload', details: { field: 'missing' } });
  });

  it('unauthorized returns 401', async () => {
    const app = new Hono();
    app.get('/test', (c) => unauthorized(c, 'Custom unauthorized'));
    const res = await app.request('/test');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Custom unauthorized' });
  });

  it('forbidden returns 403', async () => {
    const app = new Hono();
    app.get('/test', (c) => forbidden(c, 'No permission'));
    const res = await app.request('/test');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'No permission' });
  });

  it('notFound returns 404 with label', async () => {
    const app = new Hono();
    app.get('/test', (c) => notFound(c, 'Product'));
    const res = await app.request('/test');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Product not found' });
  });

  it('conflict returns 409', async () => {
    const app = new Hono();
    app.get('/test', (c) => conflict(c, 'Email already in use'));
    const res = await app.request('/test');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Email already in use' });
  });
});

describe('extractBearerToken', () => {
  it('extracts bearer token correctly', async () => {
    const app = new Hono();
    app.get('/test', (c) => c.json({ token: extractBearerToken(c) }));
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer my-secret-jwt-token' },
    });
    expect(await res.json()).toEqual({ token: 'my-secret-jwt-token' });
  });

  it('returns null when header is missing or not bearer', async () => {
    const app = new Hono();
    app.get('/test', (c) => c.json({ token: extractBearerToken(c) }));
    const res1 = await app.request('/test');
    expect(await res1.json()).toEqual({ token: null });

    const res2 = await app.request('/test', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(await res2.json()).toEqual({ token: null });
  });
});

describe('parsePagination', () => {
  it('returns defaults when no query params are present', async () => {
    const app = new Hono();
    app.get('/test', (c) => c.json(parsePagination(c)));
    const res = await app.request('/test');
    expect(await res.json()).toEqual({
      page: 1,
      pageSize: 20,
      offset: 0,
      limit: 20,
    });
  });

  it('parses page and pageSize and computes offset', async () => {
    const app = new Hono();
    app.get('/test', (c) => c.json(parsePagination(c)));
    const res = await app.request('/test?page=3&pageSize=15');
    expect(await res.json()).toEqual({
      page: 3,
      pageSize: 15,
      offset: 30,
      limit: 15,
    });
  });

  it('respects limit alias and max bounds', async () => {
    const app = new Hono();
    app.get('/test', (c) => c.json(parsePagination(c, { maxPageSize: 50 })));
    const res = await app.request('/test?page=2&limit=200');
    expect(await res.json()).toEqual({
      page: 2,
      pageSize: 50,
      offset: 50,
      limit: 50,
    });
  });
});
