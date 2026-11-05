import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { CrudDb } from '../src/crud';
import type { ApiEnv } from '../src/env';

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
  CREATE TABLE wh_docstore (
    id text PRIMARY KEY,
    data jsonb,
    created_at bigint,
    updated_at bigint,
    deleted_at bigint
  );
  CREATE TABLE wh_docstore_users (
    id text PRIMARY KEY,
    data jsonb,
    email text,
    name text,
    created_at bigint,
    updated_at bigint,
    deleted_at bigint
  );
  CREATE TABLE wh_docstore_scoped (
    id text,
    facility_id text,
    data jsonb,
    created_at bigint,
    updated_at bigint,
    deleted_at bigint,
    PRIMARY KEY (facility_id, id)
  );
  CREATE TABLE wh_text_notes (
    id text PRIMARY KEY,
    at text,
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
    dbRef = drizzle(client) as unknown as CrudDb;
  }
  return dbRef!;
}

export async function resetDb(): Promise<void> {
  if (client) await client.exec('TRUNCATE wh_widgets');
}

export async function resetOrgDb(): Promise<void> {
  if (client)
    await client.exec(
      'TRUNCATE wh_org_users, wh_orgs, wh_documents, wh_activities, wh_workdocs, wh_trio_audit, wh_trio_notes, wh_docstore, wh_docstore_users, wh_docstore_scoped, wh_text_notes',
    );
}

export function testEnv(): ApiEnv {
  return {
    DATABASE_URL: 'postgresql://pglite-in-memory',
    ASSETS: { fetch: async () => new Response('spa') },
  };
}
