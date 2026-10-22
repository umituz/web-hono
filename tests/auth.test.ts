import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { Hono } from 'hono';
import { authTables, createAuthGetter, mountAuth } from '../src/auth';
import type { AuthEnv } from '../src/auth';

describe('authTables', () => {
  it('prefixes every table name', () => {
    const tables = authTables('pkg');
    expect(getTableName(tables.user)).toBe('pkg_ba_user');
    expect(getTableName(tables.session)).toBe('pkg_ba_session');
    expect(getTableName(tables.account)).toBe('pkg_ba_account');
    expect(getTableName(tables.verification)).toBe('pkg_ba_verification');
  });
});

describe('createAuthGetter', () => {
  const tables = authTables('pkgtest');
  const getter = createAuthGetter<AuthEnv>({ db: () => ({}) as never, tables });

  it('returns the same instance for the same env', () => {
    const env = { BETTER_AUTH_SECRET: 's' };
    expect(getter(env)).toBe(getter(env));
  });

  it('returns a fresh instance per env', () => {
    expect(getter({ BETTER_AUTH_SECRET: 'a' })).not.toBe(getter({ BETTER_AUTH_SECRET: 'b' }));
  });
});

describe('mountAuth', () => {
  const tables = authTables('pkgmount');
  const getter = createAuthGetter<AuthEnv>({ db: () => ({}) as never, tables });

  it('serves better-auth endpoints under the mount path', async () => {
    const app = new Hono<{ Bindings: AuthEnv }>();
    app.route('/api/auth', mountAuth(getter));
    const res = await app.request('/api/auth/ok', {}, { BETTER_AUTH_SECRET: 's' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
