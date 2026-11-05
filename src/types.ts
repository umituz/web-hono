import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

export type Row<T extends PgTable> = InferSelectModel<T>;

export type NewRow<T extends PgTable> = InferInsertModel<T>;

export type Serialized<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};

export type ClientRow<T extends PgTable> = Serialized<Row<T>>;
