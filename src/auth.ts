import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { trio, uid } from './lib';

export interface AuthEnv {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
}

const SESSION_SECONDS = 60 * 60 * 24 * 30;
const UPDATE_AGE_SECONDS = 60 * 60 * 24;

function authTableSet(prefix: string) {
  const idx = (table: string, name: string) => `${prefix}_ba_${table}_${name}_idx`;
  const baTime = {
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  };
  const user = pgTable(`${prefix}_ba_user`, {
    id: text().primaryKey(),
    name: text().notNull(),
    email: text().notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text(),
    ...baTime,
  });
  const session = pgTable(
    `${prefix}_ba_session`,
    {
      id: text().primaryKey(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      token: text().notNull().unique(),
      ipAddress: text('ip_address'),
      userAgent: text('user_agent'),
      userId: text('user_id')
        .notNull()
        .references(() => user.id, { onDelete: 'cascade' }),
      ...baTime,
    },
    (t) => [index(idx('session', 'user')).on(t.userId)],
  );
  const account = pgTable(
    `${prefix}_ba_account`,
    {
      id: text().primaryKey(),
      accountId: text('account_id').notNull(),
      providerId: text('provider_id').notNull(),
      userId: text('user_id')
        .notNull()
        .references(() => user.id, { onDelete: 'cascade' }),
      accessToken: text('access_token'),
      refreshToken: text('refresh_token'),
      idToken: text('id_token'),
      accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
      refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
      scope: text(),
      password: text(),
      ...baTime,
    },
    (t) => [index(idx('account', 'user')).on(t.userId), uniqueIndex(idx('account', 'provider_account')).on(t.providerId, t.accountId)],
  );
  const verification = pgTable(
    `${prefix}_ba_verification`,
    {
      id: text().primaryKey(),
      identifier: text().notNull(),
      value: text().notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      ...baTime,
    },
    (t) => [index(idx('verification', 'identifier')).on(t.identifier)],
  );
  return { user, session, account, verification };
}

export const authTables = authTableSet;
export type AuthTables = ReturnType<typeof authTableSet>;

type DbLike = Parameters<typeof drizzleAdapter>[0];

export interface ResetPasswordArgs {
  user: { id: string; email: string; name: string };
  url: string;
  token: string;
}

export interface AuthOptions<E extends AuthEnv = AuthEnv> {
  db: (env: E) => DbLike;
  tables: AuthTables;
  trustedOrigins?: string[];
  sendResetPassword?: (env: E, args: ResetPasswordArgs) => Promise<void> | void;
}

function initAuth(env: AuthEnv, opts: AuthOptions<AuthEnv>) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(opts.db(env), {
      provider: 'pg',
      schema: {
        user: opts.tables.user,
        session: opts.tables.session,
        account: opts.tables.account,
        verification: opts.tables.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async (data) => {
        const send =
          opts.sendResetPassword ??
          ((_env, { user, url, token }) => {
            const link = `${new URL(url).origin}/reset-password?token=${token}`;
            console.log(`[password-reset] ${user.email} ${link}`);
          });
        await send(env, { user: data.user, url: data.url, token: data.token });
      },
      onPasswordReset: async ({ user }) => {
        await opts.db(env).delete(opts.tables.session).where(eq(opts.tables.session.userId, user.id));
      },
    },
    session: { expiresIn: SESSION_SECONDS, updateAge: UPDATE_AGE_SECONDS },
    trustedOrigins: opts.trustedOrigins ?? [],
    plugins: [bearer()],
  });
}

export type AuthInstance = ReturnType<typeof initAuth>;

export function createAuthGetter<E extends AuthEnv>(opts: AuthOptions<E>): (env: E) => AuthInstance {
  const cache = new WeakMap<object, AuthInstance>();
  return (env) => {
    let auth = cache.get(env);
    if (!auth) {
      auth = initAuth(env, opts as AuthOptions<AuthEnv>);
      cache.set(env, auth);
    }
    return auth;
  };
}

export function mountAuth<E extends AuthEnv>(getAuth: (env: E) => AuthInstance): Hono<{ Bindings: E }> {
  const router = new Hono<{ Bindings: E }>();
  router.all('*', (c) => getAuth(c.env).handler(c.req.raw));
  return router;
}

function consentTableSet(prefix: string) {
  return pgTable(
    `${prefix}_user_consents`,
    {
      id: text().primaryKey(),
      userId: text('user_id').notNull(),
      termsAccepted: boolean('terms_accepted').notNull(),
      kvkkAccepted: boolean('kvkk_accepted').notNull(),
      marketingAccepted: boolean('marketing_accepted').notNull().default(false),
      version: text().notNull(),
      ...trio(),
    },
    (t) => [index(`${prefix}_user_consents_user_idx`).on(t.userId, t.createdAt)],
  );
}

export const consentTable = consentTableSet;
export type ConsentTable = ReturnType<typeof consentTableSet>;

export function consentDdl(prefix: string): string[] {
  return [
    `create table if not exists "${prefix}_user_consents" (id text primary key, user_id text not null, terms_accepted boolean not null, kvkk_accepted boolean not null, marketing_accepted boolean not null default false, version text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz)`,
    `create index if not exists "${prefix}_user_consents_user_idx" on "${prefix}_user_consents" (user_id, created_at)`,
  ];
}

export const consentSchema = z
  .object({
    termsAccepted: z.literal(true),
    kvkkAccepted: z.literal(true),
    marketingAccepted: z.boolean(),
    version: z.string().min(1).max(64),
  })
  .strict();

export interface ConsentRouteSpec<E extends AuthEnv = AuthEnv> {
  db: (env: E) => DbLike;
  table: ConsentTable;
}

export interface AuthApiOptions<E extends AuthEnv = AuthEnv> {
  getAuth: (env: E) => AuthInstance;
  consent?: ConsentRouteSpec<E>;
}

type ListedSession = {
  id?: unknown;
  token?: unknown;
  userAgent?: unknown;
  ipAddress?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
};

export function mountAuthApi<E extends AuthEnv>(opts: AuthApiOptions<E>): Hono<{ Bindings: E }> {
  const router = new Hono<{ Bindings: E }>();
  if (opts.consent) {
    const { db, table } = opts.consent;
    router.get('/consent', async (c) => {
      const session = await opts.getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
      if (!session) return c.json({ error: 'Sign in first' }, 401);
      const [row] = await db(c.env)
        .select()
        .from(table)
        .where(eq(table.userId, session.user.id))
        .orderBy(desc(table.createdAt))
        .limit(1);
      return c.json({ consent: row ?? null });
    });
    router.post('/consent', async (c) => {
      const session = await opts.getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
      if (!session) return c.json({ error: 'Sign in first' }, 401);
      const raw = await c.req.json().catch(() => undefined);
      const parsed = consentSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'Invalid consent payload', details: parsed.error.flatten().fieldErrors }, 400);
      }
      const [row] = await db(c.env)
        .insert(table)
        .values({
          id: uid('cns'),
          userId: session.user.id,
          termsAccepted: parsed.data.termsAccepted,
          kvkkAccepted: parsed.data.kvkkAccepted,
          marketingAccepted: parsed.data.marketingAccepted,
          version: parsed.data.version,
        })
        .returning();
      return c.json(row, 201);
    });
  }
  router.get('/sessions', async (c) => {
    const auth = opts.getAuth(c.env);
    const current = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!current) return c.json({ error: 'Sign in first' }, 401);
    const listed = (await auth.api.listSessions({ headers: c.req.raw.headers })) as unknown;
    const rows = Array.isArray(listed)
      ? (listed as ListedSession[])
      : listed && typeof listed === 'object' && Array.isArray((listed as { sessions?: unknown[] }).sessions)
        ? ((listed as { sessions: unknown[] }).sessions as ListedSession[])
        : [];
    const currentToken = typeof current.session.token === 'string' ? current.session.token : null;
    const sessions = rows.map((row) => {
      const token = typeof row.token === 'string' ? row.token : null;
      const id = typeof row.id === 'string' ? row.id : (token ?? '');
      return {
        id,
        token,
        isCurrent: token !== null && currentToken !== null ? token === currentToken : id === current.session.id,
        userAgent: typeof row.userAgent === 'string' ? row.userAgent : null,
        ipAddress: typeof row.ipAddress === 'string' ? row.ipAddress : null,
        createdAt: row.createdAt ?? null,
        expiresAt: row.expiresAt ?? null,
      };
    });
    return c.json({ sessions });
  });
  router.all('*', (c) => opts.getAuth(c.env).handler(c.req.raw));
  return router;
}

export interface AuthContext<E extends AuthEnv = AuthEnv> {
  env: E;
  req: { raw: Request };
}

export interface SessionUserInfo {
  id: string;
  email: string;
  name: string;
}

export function createSessionHelpers<E extends AuthEnv>(getAuth: (env: E) => AuthInstance) {
  async function currentUser(c: AuthContext<E>): Promise<SessionUserInfo | null> {
    const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
    if (!session) return null;
    return { id: session.user.id, email: session.user.email, name: session.user.name };
  }
  async function scopeOf(c: AuthContext<E>): Promise<string | null> {
    return (await currentUser(c))?.id ?? null;
  }
  return { currentUser, scopeOf };
}
