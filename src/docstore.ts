import { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { validator } from 'hono/validator';
import type { Context } from 'hono';
import { z } from 'zod';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { validateJson } from './validator';
import type { CrudDb } from './crud';
import type { ApiEnv } from './env';

/**
 * The doc-store resource factory for jsonb-wire-faithful architectures:
 * the client owns whole documents (nested shapes, client-generated ids,
 * ISO date strings inside the doc) and the table stores them verbatim in
 * one `data jsonb` column beside the epoch-ms bookkeeping trio. The row
 * never leaks — the wire speaks docs only.
 *
 * One call returns the router (GET list / GET-PUT-PATCH-DELETE by id /
 * POST /batch) AND the motor functions (putDoc/patchDoc/softDeleteDoc/
 * listDocs/getDoc) that seed scripts and server-side workflows call
 * directly. Status machines ride along as declarative `transitions` maps and
 * write guards as `validate` hooks; violations surface as WorkflowError → 400.
 */

type RequestContext = Context<{ Bindings: ApiEnv }>;

export type Doc = Record<string, unknown> & { id: string };

export type DocTable = PgTable & { id: PgColumn; data: PgColumn; deletedAt: PgColumn };

/**
 * Cross-cutting write guard: runs inside putDoc before the write, covering
 * every path that funnels through it (PUT, PATCH-merged, batch puts,
 * server-side calls) but never putDocs seeds. Receives the incoming doc,
 * the current row when one exists, and the db for cross-collection reads
 * (booking-conflict style rules). Throw WorkflowError (or ApiError) to
 * reject the write.
 */
export type DocValidateFn = (args: { db: CrudDb; doc: Doc; existing?: Doc }) => void | Promise<void>;

export interface DocCollectionSpec {
  /** Wire collection name — the URL segment and the batch op key. */
  key: string;
  table: DocTable;
  /** Extra typed columns derived from the doc (users: email/name/flags). */
  columns?: (doc: Doc) => Record<string, unknown>;
  /** Collections that must always write the one fixed id. */
  singletonId?: string;
  /** Status state machine: allowed targets per current status. */
  transitions?: Record<string, string[]>;
  /** Doc field the transitions guard reads. Default 'status'. */
  statusKey?: string;
  /** Write guard — see DocValidateFn. */
  validate?: DocValidateFn;
}

export interface DocStoreSpec {
  collections: readonly DocCollectionSpec[];
  /** Injectable db factory (tests, Hyperdrive). Default: per-request neon-http. */
  db?: (c: RequestContext) => CrudDb;
  /** POST /batch op cap. Default 2000. */
  maxBatch?: number;
}

export class WorkflowError extends Error {}
export class UnknownCollectionError extends Error {}

/** Status machine check: staying put is always allowed. */
export function canTransition(map: Record<string, string[]>, from: string, to: string): boolean {
  return from === to || (map[from] ?? []).includes(to);
}

/** ISO string → epoch ms; anything unparsable falls back to now. */
export function epoch(iso: unknown): number {
  return typeof iso === 'string' && Date.parse(iso) ? Date.parse(iso) : Date.now();
}

function defaultDb(c: RequestContext): CrudDb {
  return drizzle(neon(c.env.DATABASE_URL));
}

export function docStore(spec: DocStoreSpec) {
  const byKey = new Map(spec.collections.map((col) => [col.key, col]));
  const getDb = spec.db ?? defaultDb;
  const maxBatch = spec.maxBatch ?? 2000;

  function collectionOf(key: string): DocCollectionSpec | undefined {
    return byKey.get(key);
  }

  function requireSpec(key: string): DocCollectionSpec {
    const col = byKey.get(key);
    if (!col) throw new UnknownCollectionError(`Unknown collection '${key}'`);
    return col;
  }

  function rowValues(col: DocCollectionSpec, doc: Doc, nowMs: number): Record<string, unknown> {
    const id = String(doc.id);
    return {
      id,
      createdAt: epoch(doc.createdAt) || nowMs,
      updatedAt: epoch(doc.updatedAt) || nowMs,
      deletedAt: null as number | null,
      data: doc,
      ...col.columns?.(doc),
    };
  }

  async function putDoc(db: CrudDb, key: string, doc: Doc): Promise<void> {
    const col = requireSpec(key);
    if (col.singletonId && String(doc.id) !== col.singletonId) {
      throw new WorkflowError(`Singleton collection '${key}' must use id '${col.singletonId}'`);
    }
    const guard = col.transitions;
    if (guard || col.validate) {
      const [existingRow] = await db
        .select({ data: col.table.data })
        .from(col.table)
        .where(and(eq(col.table.id, String(doc.id)), isNull(col.table.deletedAt)))
        .limit(1);
      const existing = existingRow?.data as Doc | undefined;
      if (guard) {
        const statusKey = col.statusKey ?? 'status';
        if (existing) {
          const from = existing[statusKey];
          const to = doc[statusKey];
          if (typeof from === 'string' && typeof to === 'string' && !canTransition(guard, from, to)) {
            throw new WorkflowError(`Invalid ${key} transition ${from} → ${to}`);
          }
        }
      }
      await col.validate?.({ db, doc, existing });
    }
    const values = rowValues(col, doc, Date.now());
    await db
      .insert(col.table)
      .values(values as never)
      .onConflictDoUpdate({
        target: [col.table.id],
        set: { updatedAt: values.updatedAt, deletedAt: null, data: values.data } as never,
      });
  }

  /** Trusted bulk load for seed scripts: chunked multi-row upsert with the
   *  same revive semantics as putDoc, without per-row workflow/singleton
   *  guards (seeds write fresh, consistent datasets by construction). */
  async function putDocs(db: CrudDb, key: string, docs: readonly Doc[], chunkSize = 200): Promise<number> {
    const col = requireSpec(key);
    let count = 0;
    for (let i = 0; i < docs.length; i += chunkSize) {
      const chunk = docs.slice(i, i + chunkSize).map((doc) => rowValues(col, doc, Date.now()));
      await db
        .insert(col.table)
        .values(chunk as never)
        .onConflictDoUpdate({
          target: [col.table.id],
          set: { updatedAt: sql`excluded.updated_at`, deletedAt: null, data: sql`excluded.data` } as never,
        });
      count += chunk.length;
    }
    return count;
  }

  async function patchDoc(db: CrudDb, key: string, id: string, patch: Record<string, unknown>): Promise<Doc | undefined> {
    requireSpec(key);
    const col = byKey.get(key)!;
    const [row] = await db
      .select()
      .from(col.table)
      .where(and(eq(col.table.id, id), isNull(col.table.deletedAt)))
      .limit(1);
    const merged: Doc = row ? { ...(row.data as Doc), ...patch, id } : { ...patch, id };
    merged.updatedAt = new Date().toISOString();
    await putDoc(db, key, merged);
    return merged;
  }

  async function softDeleteDoc(db: CrudDb, key: string, id: string): Promise<boolean> {
    const col = requireSpec(key);
    const res = await db
      .update(col.table)
      .set({ deletedAt: Date.now() } as never)
      .where(eq(col.table.id, id))
      .returning({ id: col.table.id });
    return res.length > 0;
  }

  async function listDocs(db: CrudDb, key: string): Promise<Doc[]> {
    const col = requireSpec(key);
    const rows = await db
      .select({ data: col.table.data })
      .from(col.table)
      .where(isNull(col.table.deletedAt))
      .orderBy(col.table.id);
    return rows.map((r) => r.data as Doc);
  }

  async function getDoc(db: CrudDb, key: string, id: string): Promise<Doc | undefined> {
    const col = requireSpec(key);
    const [row] = await db
      .select({ data: col.table.data })
      .from(col.table)
      .where(and(eq(col.table.id, id), isNull(col.table.deletedAt)))
      .limit(1);
    return row?.data as Doc | undefined;
  }

  const docSchema = z.object({ id: z.string().min(1) }).passthrough();
  const patchSchema = z.record(z.string(), z.unknown()).refine((r) => Object.keys(r).length > 0, 'Empty patch');
  const batchSchema = z.object({
    ops: z
      .array(
        z.discriminatedUnion('op', [
          z.object({ op: z.literal('put'), collection: z.string(), doc: docSchema }),
          z.object({ op: z.literal('del'), collection: z.string(), id: z.string().min(1) }),
        ]),
      )
      .min(1)
      .max(maxBatch),
  }).strict();

  const router = new Hono<{ Bindings: ApiEnv }>();

  router.get('/:collection', async (c) => {
    try {
      requireSpec(c.req.param('collection'));
    } catch {
      return c.json({ error: 'Unknown collection', collection: c.req.param('collection') }, 404);
    }
    return c.json(await listDocs(getDb(c), c.req.param('collection')));
  });

  router.get('/:collection/:id', async (c) => {
    try {
      requireSpec(c.req.param('collection'));
    } catch {
      return c.json({ error: 'Unknown collection', collection: c.req.param('collection') }, 404);
    }
    const doc = await getDoc(getDb(c), c.req.param('collection'), c.req.param('id'));
    return doc ? c.json(doc) : c.json({ error: 'Document not found' }, 404);
  });

  router.put('/:collection/:id', validator('json', validateJson(docSchema, 'Invalid document payload')), async (c) => {
    const key = c.req.param('collection');
    try {
      requireSpec(key);
    } catch {
      return c.json({ error: 'Unknown collection', collection: key }, 404);
    }
    const doc = c.req.valid('json') as unknown as Doc;
    if (doc.id !== c.req.param('id')) {
      return c.json({ error: 'Body id does not match the URL' }, 400);
    }
    try {
      await putDoc(getDb(c), key, doc);
    } catch (err) {
      if (err instanceof WorkflowError) return c.json({ error: err.message }, 400);
      throw err;
    }
    return c.json(doc, 201);
  });

  router.patch('/:collection/:id', validator('json', validateJson(patchSchema, 'Invalid patch payload')), async (c) => {
    const key = c.req.param('collection');
    try {
      requireSpec(key);
    } catch {
      return c.json({ error: 'Unknown collection', collection: key }, 404);
    }
    try {
      const merged = await patchDoc(getDb(c), key, c.req.param('id'), c.req.valid('json') as unknown as Doc);
      return c.json(merged ?? {});
    } catch (err) {
      if (err instanceof WorkflowError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  router.delete('/:collection/:id', async (c) => {
    try {
      requireSpec(c.req.param('collection'));
    } catch {
      return c.json({ error: 'Unknown collection', collection: c.req.param('collection') }, 404);
    }
    const gone = await softDeleteDoc(getDb(c), c.req.param('collection'), c.req.param('id'));
    return gone ? c.json({ ok: true }) : c.json({ error: 'Document not found' }, 404);
  });

  router.post('/batch', validator('json', validateJson(batchSchema, 'Invalid batch payload')), async (c) => {
    const applied: { collection: string; id: string }[] = [];
    try {
      for (const op of c.req.valid('json').ops) {
        requireSpec(op.collection);
        if (op.op === 'put') {
          await putDoc(getDb(c), op.collection, op.doc as Doc);
          applied.push({ collection: op.collection, id: String(op.doc.id) });
        } else {
          await softDeleteDoc(getDb(c), op.collection, op.id);
          applied.push({ collection: op.collection, id: op.id });
        }
      }
    } catch (err) {
      if (err instanceof WorkflowError) return c.json({ error: err.message, applied: applied.length }, 400);
      if (err instanceof UnknownCollectionError) return c.json({ error: err.message, applied: applied.length }, 404);
      throw err;
    }
    return c.json({ ok: true, applied: applied.length });
  });

  return {
    router,
    collectionOf,
    putDoc,
    putDocs,
    patchDoc,
    softDeleteDoc,
    listDocs,
    getDoc,
  };
}
