import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  queryString,
  queryInt,
  queryNumber,
  queryBoolean,
  queryArray,
  paramInt,
  success,
  tooManyRequests,
  unprocessable,
  gone,
  payloadTooLarge,
} from '../src/http';

describe('http query and param helpers', () => {
  it('parses query strings and integers with bounds', async () => {
    const app = new Hono();
    app.get('/test/:id', (c) => {
      const qStr = queryString(c, 'name', 'guest');
      const qInt = queryInt(c, 'page', 1, { min: 1, max: 100 });
      const qClamped = queryInt(c, 'limit', 10, { min: 5, max: 50 });
      const qNum = queryNumber(c, 'price');
      const qBool = queryBoolean(c, 'active', false);
      const qArr = queryArray(c, 'tags');
      const pId = paramInt(c, 'id');
      return c.json({ qStr, qInt, qClamped, qNum, qBool, qArr, pId });
    });

    const res = await app.request(
      'http://localhost/test/42?name=Alice&page=200&limit=1&price=19.99&active=true&tags=ts,js,hono',
    );
    const body = await res.json();
    expect(body).toEqual({
      qStr: 'Alice',
      qInt: 100,
      qClamped: 5,
      qNum: 19.99,
      qBool: true,
      qArr: ['ts', 'js', 'hono'],
      pId: 42,
    });
  });

  it('uses fallbacks when values are absent or invalid', async () => {
    const app = new Hono();
    app.get('/fallback/:id', (c) => {
      const qStr = queryString(c, 'missing', 'default-val');
      const qInt = queryInt(c, 'invalid', 10);
      const qNum = queryNumber(c, 'bad-num', 0);
      const qBool = queryBoolean(c, 'missing-bool', true);
      const qArr = queryArray(c, 'empty');
      const pId = paramInt(c, 'id', -1);
      return c.json({ qStr, qInt, qNum, qBool, qArr, pId });
    });

    const res = await app.request('http://localhost/fallback/abc?invalid=abc&bad-num=not-a-number');
    const body = await res.json();
    expect(body).toEqual({
      qStr: 'default-val',
      qInt: 10,
      qNum: 0,
      qBool: true,
      qArr: [],
      pId: -1,
    });
  });
});

describe('http response helpers', () => {
  it('returns success with custom data', async () => {
    const app = new Hono();
    app.post('/done', (c) => success(c, { id: 'x1', count: 5 }, 201));

    const res = await app.request('http://localhost/done', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, id: 'x1', count: 5 });
  });

  it('returns tooManyRequests with Retry-After header', async () => {
    const app = new Hono();
    app.get('/rate', (c) => tooManyRequests(c, 'Quota reached', 60));

    const res = await app.request('http://localhost/rate');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).toEqual({ error: 'Quota reached' });
  });

  it('returns unprocessable, gone, and payloadTooLarge', async () => {
    const app = new Hono();
    app.get('/unproc', (c) => unprocessable(c, 'Semantic validation failed', { field: 'age' }));
    app.get('/gone', (c) => gone(c));
    app.get('/large', (c) => payloadTooLarge(c));

    const res1 = await app.request('http://localhost/unproc');
    expect(res1.status).toBe(422);
    expect(await res1.json()).toEqual({
      error: 'Semantic validation failed',
      details: { field: 'age' },
    });

    const res2 = await app.request('http://localhost/gone');
    expect(res2.status).toBe(410);
    expect(await res2.json()).toEqual({ error: 'Resource gone' });

    const res3 = await app.request('http://localhost/large');
    expect(res3.status).toBe(413);
    expect(await res3.json()).toEqual({ error: 'Payload too large' });
  });
});
