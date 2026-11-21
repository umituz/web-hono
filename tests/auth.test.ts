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

  it('merges static and env-derived plugins into the instance options', () => {
    const staticPlugin = { id: 'static-plugin', version: '1' } as never;
    const conditionalPlugin = { id: 'conditional-plugin', version: '1' } as never;
    const withPlugins = createAuthGetter<AuthEnv & { CAPTCHA?: string }>({
      db: () => ({}) as never,
      tables,
      plugins: (env) => (env.CAPTCHA ? [conditionalPlugin] : []),
    });
    withPlugins({ BETTER_AUTH_SECRET: 's' });
    withPlugins({ BETTER_AUTH_SECRET: 's', CAPTCHA: 'x' });

    const plain = createAuthGetter<AuthEnv>({ db: () => ({}) as never, tables, plugins: [staticPlugin] });
    const instance = plain({ BETTER_AUTH_SECRET: 's' }) as unknown as {
      options: { plugins: Array<{ id: string }> };
    };
    const ids = instance.options.plugins.map((plugin) => plugin.id);
    expect(ids).toContain('bearer');
    expect(ids).toContain('static-plugin');
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
