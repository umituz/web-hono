import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  zStrictQuery,
  zLooseQuery,
  zStrictParam,
  zLooseParam,
  email,
  trimmedString,
  safeId,
  sortOrderQuery,
  booleanQuery,
  commaSeparatedQuery,
} from '../src/validator';

describe('validator extensions', () => {
  it('validates strict and loose queries', async () => {
    const app = new Hono();
    app.get(
      '/strict-q',
      zStrictQuery({
        page: z.coerce.number(),
      }),
      (c) => c.json(c.req.valid('query' as never)),
    );

    app.get(
      '/loose-q',
      zLooseQuery({
        page: z.coerce.number(),
      }),
      (c) => c.json(c.req.valid('query' as never)),
    );

    const res1 = await app.request('http://localhost/strict-q?page=2');
    expect(res1.status).toBe(200);

    const res2 = await app.request('http://localhost/strict-q?page=2&extra=unexpected');
    expect(res2.status).toBe(400);

    const res3 = await app.request('http://localhost/loose-q?page=2&extra=allowed');
    expect(res3.status).toBe(200);
  });

  it('validates strict and loose path parameters', async () => {
    const app = new Hono();
    app.get(
      '/user/:id',
      zStrictParam({
        id: z.string().min(3),
      }),
      (c) => c.json(c.req.valid('param' as never)),
    );

    app.get(
      '/loose-user/:id',
      zLooseParam({
        id: z.string().min(3),
      }),
      (c) => c.json(c.req.valid('param' as never)),
    );

    const res1 = await app.request('http://localhost/user/abc');
    expect(res1.status).toBe(200);

    const res2 = await app.request('http://localhost/user/a');
    expect(res2.status).toBe(400);

    const res3 = await app.request('http://localhost/loose-user/xyz');
    expect(res3.status).toBe(200);
  });

  it('validates email, trimmedString, safeId, and sortOrderQuery', () => {
    expect(email.parse('  User@Example.COM  ')).toBe('user@example.com');
    expect(() => email.parse('invalid-email')).toThrow();

    const strSchema = trimmedString(2, 10);
    expect(strSchema.parse('  hello  ')).toBe('hello');
    expect(() => strSchema.parse('a')).toThrow();
    expect(() => strSchema.parse('this is way too long')).toThrow();

    expect(safeId.parse('usr_12345')).toBe('usr_12345');
    expect(() => safeId.parse('')).toThrow();

    expect(sortOrderQuery.parse(undefined)).toBe('asc');
    expect(sortOrderQuery.parse('desc')).toBe('desc');
    expect(() => sortOrderQuery.parse('other')).toThrow();
  });

  it('transforms booleanQuery and commaSeparatedQuery', () => {
    expect(booleanQuery.parse('true')).toBe(true);
    expect(booleanQuery.parse('1')).toBe(true);
    expect(booleanQuery.parse('yes')).toBe(true);
    expect(booleanQuery.parse('false')).toBe(false);
    expect(booleanQuery.parse('0')).toBe(false);
    expect(booleanQuery.parse('no')).toBe(false);
    expect(() => booleanQuery.parse('maybe')).toThrow();

    expect(commaSeparatedQuery.parse('apple, banana , orange ,')).toEqual(['apple', 'banana', 'orange']);
    expect(commaSeparatedQuery.parse('')).toEqual([]);
  });
});
