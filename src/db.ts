import { createDb } from '@umituz/web-database';

export function getDb<TSchema extends Record<string, unknown>>(env: { DATABASE_URL: string }, schema: TSchema) {
  return createDb(env.DATABASE_URL, schema);
}
