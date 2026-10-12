import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';

/**
 * neon-http driver: fetch-based, serverless-friendly — no connection pool,
 * no Hyperdrive needed. Each request gets its own HTTP call to Neon.
 *
 * `schema` is the app's drizzle schema (`import * as schema from './schema'`)
 * and enables relational `db.query.*` access; plain select/insert/update
 * paths work regardless.
 */
export function getDb<TSchema extends Record<string, unknown>>(env: { DATABASE_URL: string }, schema: TSchema) {
  const sql = neon(env.DATABASE_URL);
  return drizzle(sql, { schema });
}
