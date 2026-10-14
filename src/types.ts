import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * The server↔client type bridge. The drizzle schema is the single source of
 * truth: the server row, the wire shape, and the store cache all DERIVE from
 * it — no hand-mirrored interface files that silently drift (the 1.x fleet
 * maintained those by convention only).
 *
 *   // app schema: export const products = pgTable(...)
 *   type Product = ClientRow<typeof products>;   // what src/data/store.ts caches
 *   type NewProduct = NewRow<typeof products>;   // what a POST body becomes
 *
 * This entry is type-only — client code importing it pulls no server runtime.
 */

/** The server-side row straight from the drizzle schema (Date objects for
 *  timestamptz columns — what drizzle returns, what handlers pass to c.json). */
export type Row<T extends PgTable> = InferSelectModel<T>;

/** The insert shape (POST bodies after zod) — defaults/optional per schema. */
export type NewRow<T extends PgTable> = InferInsertModel<T>;

/** What JSON.stringify delivers over the wire: Date → ISO string, everything
 *  else (jsonb, enums, date mode:'string' columns — already strings) as-is. */
export type Serialized<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};

/** The client-cached row type: what apiFetch/store hold after c.json(). */
export type ClientRow<T extends PgTable> = Serialized<Row<T>>;
