import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';

export function getDb<TSchema extends Record<string, unknown>>(env: { DATABASE_URL: string }, schema: TSchema) {
  const sql = neon(env.DATABASE_URL);
  return drizzle(sql, { schema });
}
