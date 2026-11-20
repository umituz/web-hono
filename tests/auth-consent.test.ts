import { beforeAll, describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { Hono } from 'hono';
import { consentDdl, consentSchema, consentTable, mountAuthApi } from '../src/auth';
import type { AuthEnv, AuthInstance } from '../src/auth';

const table = consentTable('wh');

function fakeAuth(signedIn: boolean): AuthInstance {
  return {
    api: {
      getSession: async () =>
        signedIn ? { user: { id: 'u1', email: 'a@b.c', name: 'A' }, session: { id: 's1', token: 'tok-1' } } : null,
      listSessions: async () => [
        { id: 's1', token: 'tok-1', userAgent: 'Mozilla/5.0 macOS', ipAddress: '9.9.9.9', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-02-01T00:00:00Z' },
        { id: 's2', token: 'tok-2', userAgent: 'iPhone Safari iOS', ipAddress: '8.8.8.8', createdAt: '2026-01-02T00:00:00Z', expiresAt: '2026-02-02T00:00:00Z' },
      ],
    },
    handler: () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
  } as unknown as AuthInstance;
}

describe('consentTable', () => {
  it('prefixes the table name', () => {
    expect(getTableName(consentTable('pkg'))).toBe('pkg_user_consents');
  });
});

describe('consentDdl', () => {
  it('returns idempotent statements for the prefix', () => {
    const ddl = consentDdl('pkg');
    expect(ddl).toHaveLength(2);
    expect(ddl[0]).toContain('create table if not exists "pkg_user_consents"');
    expect(ddl[1]).toContain('create index if not exists "pkg_user_consents_user_idx"');
  });
});

describe('consentSchema', () => {
  it('rejects missing kvkk acceptance', () => {
    expect(consentSchema.safeParse({ termsAccepted: true, marketingAccepted: false, version: 'v1' }).success).toBe(false);
  });
  it('rejects false terms acceptance', () => {
    expect(consentSchema.safeParse({ termsAccepted: false, kvkkAccepted: true, marketingAccepted: false, version: 'v1' }).success).toBe(false);
  });
  it('rejects unknown fields', () => {
    expect(consentSchema.safeParse({ termsAccepted: true, kvkkAccepted: true, marketingAccepted: false, version: 'v1', extra: 1 }).success).toBe(false);
  });
  it('accepts a valid payload', () => {
    expect(consentSchema.safeParse({ termsAccepted: true, kvkkAccepted: true, marketingAccepted: true, version: '2026-11-20' }).success).toBe(true);
  });
});

describe('mountAuthApi', () => {
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    const pg = new PGlite();
    await pg.exec(consentDdl('wh').join(';\n'));
    db = drizzle(pg);
  });

  function makeApp(signedIn: boolean, withConsent = true) {
    const auth = fakeAuth(signedIn);
    const app = new Hono<{ Bindings: AuthEnv }>();
    app.route(
      '/api/auth',
      mountAuthApi({
        getAuth: () => auth,
        ...(withConsent ? { consent: { db: () => db as never, table } } : {}),
      }),
    );
    return app;
  }

  it('returns 401 for /consent without a session', async () => {
    const res = await makeApp(false).request('/api/auth/consent', {}, { BETTER_AUTH_SECRET: 's' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for /sessions without a session', async () => {
    const res = await makeApp(false).request('/api/auth/sessions', {}, { BETTER_AUTH_SECRET: 's' });
    expect(res.status).toBe(401);
  });

  it('marks the current session by token', async () => {
    const res = await makeApp(true).request('/api/auth/sessions', {}, { BETTER_AUTH_SECRET: 's' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0].isCurrent).toBe(true);
    expect(body.sessions[0].userAgent).toBe('Mozilla/5.0 macOS');
    expect(body.sessions[1].isCurrent).toBe(false);
  });

  it('returns null consent when nothing was recorded', async () => {
    const res = await makeApp(true).request('/api/auth/consent', {}, { BETTER_AUTH_SECRET: 's' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ consent: null });
  });

  it('rejects an invalid consent payload with 400', async () => {
    const res = await makeApp(true).request(
      '/api/auth/consent',
      { method: 'POST', body: JSON.stringify({ termsAccepted: true, kvkkAccepted: false, marketingAccepted: false, version: 'v1' }) },
      { BETTER_AUTH_SECRET: 's' },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid consent payload');
  });

  it('records a consent row and returns the latest on GET', async () => {
    const post = await makeApp(true).request(
      '/api/auth/consent',
      { method: 'POST', body: JSON.stringify({ termsAccepted: true, kvkkAccepted: true, marketingAccepted: false, version: 'v1' }) },
      { BETTER_AUTH_SECRET: 's' },
    );
    expect(post.status).toBe(201);
    const row = await post.json();
    expect(row.userId).toBe('u1');
    expect(row.version).toBe('v1');
    expect(row.termsAccepted).toBe(true);

    await makeApp(true).request(
      '/api/auth/consent',
      { method: 'POST', body: JSON.stringify({ termsAccepted: true, kvkkAccepted: true, marketingAccepted: true, version: 'v2' }) },
      { BETTER_AUTH_SECRET: 's' },
    );

    const get = await makeApp(true).request('/api/auth/consent', {}, { BETTER_AUTH_SECRET: 's' });
    const body = await get.json();
    expect(body.consent.version).toBe('v2');
    expect(body.consent.marketingAccepted).toBe(true);
  });

  it('still passes unknown paths through to better-auth', async () => {
    const res = await makeApp(true).request('/api/auth/ok', {}, { BETTER_AUTH_SECRET: 's' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('serves sessions even without a consent spec', async () => {
    const res = await makeApp(true, false).request('/api/auth/sessions', {}, { BETTER_AUTH_SECRET: 's' });
    expect(res.status).toBe(200);
  });
});
