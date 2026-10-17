import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { CrudDb } from '../src/crud';
import type { ApiEnv } from '../src/env';

/* Internal test harness: REAL in-memory Postgres for factory coverage — no
 * Neon, no network. The raw DDL mirrors tests/helpers.ts fixture tables and
 * documents the actual SQL contract the factory depends on (text pk,
 * timestamptz trio). The unique index on name exists solely to prove the
 * postgres 23505 → 409 mapping through apiOnError.
 *
 * One PGlite instance per process (startup is the slow part) — tests reset
 * state with TRUNCATE, which keeps schema and defaults. */

const DDL = `
  CREATE TABLE wh_widgets (
    id text PRIMARY KEY,
    name text,
    count integer,
    opened_at timestamptz,
    best_before date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );
  CREATE UNIQUE INDEX wh_widgets_name_key ON wh_widgets (name);
  CREATE TABLE wh_org_users (
    id text PRIMARY KEY,
    organization_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );
  CREATE TABLE wh_orgs (
    id text PRIMARY KEY,
    modes jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );
  CREATE TABLE wh_documents (
    id text PRIMARY KEY,
    number text,
    organization_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );
  CREATE TABLE wh_activities (
    id text PRIMARY KEY,
    at timestamptz,
    actor_id text,
    actor_name text,
    action text,
    entity_type text,
    entity_id text,
    entity_label text,
    changes jsonb,
    type text,
    severity text,
    title text,
    body text,
    read boolean,
    branch_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );
  CREATE TABLE wh_workdocs (
    id text PRIMARY KEY,
    number text,
    workspace_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );
  CREATE TABLE wh_trio_audit (
    id text PRIMARY KEY,
    created_at timestamptz,
    actor_id text,
    actor_name text,
    action text,
    entity_type text,
    entity_id text,
    entity_label text,
    changes jsonb
  );
  CREATE TABLE wh_trio_notes (
    id text PRIMARY KEY,
    created_at timestamptz,
    severity text,
    title text,
    body text
  );
`;

let client: PGlite | null = null;
let dbRef: CrudDb | null = null;

export async function makeTestDb(): Promise<CrudDb> {
  if (!client) {
    client = new PGlite();
    await client.exec(DDL);
    // Cross-driver injection (pglite vs neon-http) is type-level only.
    dbRef = drizzle(client) as unknown as CrudDb;
  }
  return dbRef!;
}

/** Fast per-test reset: rows gone, schema/defaults kept. */
export async function resetDb(): Promise<void> {
  if (client) await client.exec('TRUNCATE wh_widgets');
}

/** Reset for the org/activity fixtures (separate so crud resets stay minimal). */
export async function resetOrgDb(): Promise<void> {
  if (client)
    await client.exec('TRUNCATE wh_org_users, wh_orgs, wh_documents, wh_activities, wh_workdocs, wh_trio_audit, wh_trio_notes');
}

/** Bindings the factory needs; DATABASE_URL is unused once db is injected. */
export function testEnv(): ApiEnv {
  return {
    DATABASE_URL: 'postgresql://pglite-in-memory',
    ASSETS: { fetch: async () => new Response('spa') },
  };
}
