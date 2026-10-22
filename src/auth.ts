import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

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
  sendResetPassword?: (args: ResetPasswordArgs) => Promise<void> | void;
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
          opts.sendResetPassword ?? (({ user, url }) => console.log(`[password-reset] ${user.email} ${url}`));
        await send({ user: data.user, url: data.url, token: data.token });
      },
      onPasswordReset: async ({ user }) => {
        await opts.db(env).delete(opts.tables.session).where(eq(opts.tables.session.userId, user.id));
      },
    },
    session: { expiresIn: SESSION_SECONDS, updateAge: UPDATE_AGE_SECONDS },
    trustedOrigins: opts.trustedOrigins ?? [],
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
