import { Hono } from 'hono';
import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
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
export type DocInput = Record<string, unknown>;

export type DocTable = PgTable & { id: PgColumn; data: PgColumn; deletedAt: PgColumn };

export interface DocScopeSpec {
  column: PgColumn;
  field: string;
}

/**
 * Cross-cutting write guard: runs inside putDoc before the write, covering
 * every path that funnels through it (PUT, PATCH-merged, batch puts,
 * server-side calls) but never putDocs seeds. Receives the incoming doc,
 * the current row when one exists, and the db for cross-collection reads
 * (booking-conflict style rules). Throw WorkflowError (or ApiError) to
 * reject the write.
 */
export type DocValidateFn = (args: { db: CrudDb; doc: DocInput; existing?: DocInput }) => void | Promise<void>;

export type DocAfterWriteFn = (args: { db: CrudDb; key: string; id: string; doc: Doc; op: 'put' | 'delete' }) => void | Promise<void>;

export interface DocCollectionSpec {
  /** Wire collection name — the URL segment and the batch op key. */
  key: string;
  table: DocTable;
  /** Extra typed columns derived from the doc (users: email/name/flags). */
  columns?: (doc: DocInput) => Record<string, unknown>;
  /** Collections that must always write the one fixed id. */
  singletonId?: string;
  /** Status state machine: allowed targets per current status. */
  transitions?: Record<string, string[]>;
  /** Doc field the transitions guard reads. Default 'status'. */
  statusKey?: string;
  /** Write guard — see DocValidateFn. */
  validate?: DocValidateFn;
  idField?: string;
  scope?: DocScopeSpec;
  afterWrite?: DocAfterWriteFn;
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

  function idFieldOf(col: DocCollectionSpec): string {
    return col.idField ?? 'id';
  }

  function docIdOf(col: DocCollectionSpec, doc: DocInput): string {
    const value = doc[idFieldOf(col)];
    if (typeof value !== 'string' || value.length === 0) {
      throw new WorkflowError(`Document must carry a non-empty '${idFieldOf(col)}'`);
    }
    return value;
  }

  function scopePropOf(col: DocCollectionSpec): string {
    if (!col.scope) throw new WorkflowError('Collection is not scoped');
    const columns = getTableColumns(col.table) as unknown as Record<string, PgColumn>;
    const prop = Object.keys(columns).find((k) => columns[k] === col.scope!.column);
    if (!prop) throw new UnknownCollectionError('Scope column not found on the collection table');
    return prop;
  }

  function scopeValueOf(col: DocCollectionSpec, doc: DocInput): string {
    const value = col.scope ? doc[col.scope.field] : undefined;
    if (typeof value !== 'string' || value.length === 0) {
      throw new WorkflowError(`Document must carry a non-empty '${col.scope?.field}'`);
    }
    return value;
  }

  function idConds(col: DocCollectionSpec, id: string, scope: string | undefined, live: boolean) {
    const conds = [eq(col.table.id, id)];
    if (col.scope) {
      if (!scope) throw new WorkflowError(`Scoped collection '${col.key}' requires a scope value`);
      conds.push(eq(col.scope.column, scope));
    }
    if (live) conds.push(isNull(col.table.deletedAt));
    return and(...conds);
  }

  function rowValues(col: DocCollectionSpec, doc: DocInput, nowMs: number): Record<string, unknown> {
    const id = docIdOf(col, doc);
    const values: Record<string, unknown> = {
      id,
      createdAt: epoch(doc.createdAt) || nowMs,
      updatedAt: epoch(doc.updatedAt) || nowMs,
      deletedAt: null as number | null,
      data: doc,
      ...col.columns?.(doc),
    };
    if (col.scope) values[scopePropOf(col)] = scopeValueOf(col, doc);
    return values;
  }

  async function putDoc(db: CrudDb, key: string, doc: DocInput): Promise<void> {
    const col = requireSpec(key);
    const id = docIdOf(col, doc);
    if (col.singletonId && id !== col.singletonId) {
      throw new WorkflowError(`Singleton collection '${key}' must use id '${col.singletonId}'`);
    }
    const guard = col.transitions;
    if (guard || col.validate) {
      const [existingRow] = await db
        .select({ data: col.table.data })
        .from(col.table)
        .where(idConds(col, id, col.scope ? scopeValueOf(col, doc) : undefined, true))
        .limit(1);
      const existing = existingRow?.data as DocInput | undefined;
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
        target: col.scope ? [col.scope.column, col.table.id] : [col.table.id],
        set: { updatedAt: values.updatedAt, deletedAt: null, data: values.data } as never,
      });
    if (col.afterWrite) await col.afterWrite({ db, key, id, doc: doc as Doc, op: 'put' });
  }

  /** Trusted bulk load for seed scripts: chunked multi-row upsert with the
   *  same revive semantics as putDoc, without per-row workflow/singleton
   *  guards (seeds write fresh, consistent datasets by construction). */
  async function putDocs(db: CrudDb, key: string, docs: readonly DocInput[], chunkSize = 200): Promise<number> {
    const col = requireSpec(key);
    let count = 0;
    for (let i = 0; i < docs.length; i += chunkSize) {
      const chunk = docs.slice(i, i + chunkSize).map((doc) => rowValues(col, doc, Date.now()));
      await db
        .insert(col.table)
        .values(chunk as never)
        .onConflictDoUpdate({
          target: col.scope ? [col.scope.column, col.table.id] : [col.table.id],
          set: { updatedAt: sql`excluded.updated_at`, deletedAt: null, data: sql`excluded.data` } as never,
        });
      count += chunk.length;
    }
    return count;
  }

  async function patchDoc(db: CrudDb, key: string, id: string, patch: DocInput, scope?: string): Promise<Doc | undefined> {
    const col = requireSpec(key);
    const [row] = await db
      .select()
      .from(col.table)
      .where(idConds(col, id, scope, true))
      .limit(1);
    const fld = idFieldOf(col);
    const merged: DocInput = row ? { ...(row.data as DocInput), ...patch, [fld]: id } : { ...patch, [fld]: id };
    if (col.scope && scope) merged[col.scope.field] = scope;
    merged.updatedAt = new Date().toISOString();
    await putDoc(db, key, merged);
    return merged as Doc;
  }

  async function softDeleteDoc(db: CrudDb, key: string, id: string, scope?: string): Promise<boolean> {
    const col = requireSpec(key);
    let before: DocInput | undefined;
    if (col.afterWrite) {
      const [row] = await db
        .select({ data: col.table.data })
        .from(col.table)
        .where(idConds(col, id, scope, true))
        .limit(1);
      before = row?.data as DocInput | undefined;
    }
    const res = await db
      .update(col.table)
      .set({ deletedAt: Date.now() } as never)
      .where(idConds(col, id, scope, false))
      .returning({ id: col.table.id });
    if (res.length > 0 && col.afterWrite && before) {
      await col.afterWrite({ db, key, id, doc: before as Doc, op: 'delete' });
    }
    return res.length > 0;
  }

  async function listDocs(db: CrudDb, key: string, scope?: string): Promise<Doc[]> {
    const col = requireSpec(key);
    const conds = [isNull(col.table.deletedAt)];
    if (col.scope && scope !== undefined) conds.push(eq(col.scope.column, scope));
    const rows = await db
      .select({ data: col.table.data })
      .from(col.table)
      .where(and(...conds))
      .orderBy(col.table.id);
    return rows.map((r) => r.data as Doc);
  }

  async function getDoc(db: CrudDb, key: string, id: string, scope?: string): Promise<Doc | undefined> {
    const col = requireSpec(key);
    const [row] = await db
      .select({ data: col.table.data })
      .from(col.table)
      .where(idConds(col, id, scope, true))
      .limit(1);
    return row?.data as Doc | undefined;
  }

  const docSchema = z.record(z.string(), z.unknown());
  const patchSchema = z.record(z.string(), z.unknown()).refine((r) => Object.keys(r).length > 0, 'Empty patch');
  const batchSchema = z.object({
    ops: z
      .array(
        z.discriminatedUnion('op', [
          z.object({ op: z.literal('put'), collection: z.string(), doc: docSchema }),
          z.object({ op: z.literal('del'), collection: z.string(), id: z.string().min(1), scope: z.string().min(1).optional() }),
        ]),
      )
      .min(1)
      .max(maxBatch),
  }).strict();

  function requireScopeQuery(c: RequestContext, col: DocCollectionSpec): string | undefined {
    if (!col.scope) return undefined;
    const q = c.req.query('scope');
    if (!q) throw new WorkflowError(`Scoped collection '${col.key}' requires a scope query`);
    return q;
  }

  const router = new Hono<{ Bindings: ApiEnv }>();

  router.get('/:collection', async (c) => {
    try {
      requireSpec(c.req.param('collection'));
    } catch {
      return c.json({ error: 'Unknown collection', collection: c.req.param('collection') }, 404);
    }
    return c.json(await listDocs(getDb(c), c.req.param('collection'), c.req.query('scope')));
  });

  router.get('/:collection/:id', async (c) => {
    let col: DocCollectionSpec;
    try {
      col = requireSpec(c.req.param('collection'));
    } catch {
      return c.json({ error: 'Unknown collection', collection: c.req.param('collection') }, 404);
    }
    let scope: string | undefined;
    try {
      scope = requireScopeQuery(c, col);
    } catch (err) {
      if (err instanceof WorkflowError) return c.json({ error: err.message }, 400);
      throw err;
    }
    const doc = await getDoc(getDb(c), col.key, c.req.param('id'), scope);
    return doc ? c.json(doc) : c.json({ error: 'Document not found' }, 404);
  });

  router.put('/:collection/:id', validator('json', validateJson(docSchema, 'Invalid document payload')), async (c) => {
    const key = c.req.param('collection');
    let col: DocCollectionSpec;
    try {
      col = requireSpec(key);
    } catch {
      return c.json({ error: 'Unknown collection', collection: key }, 404);
    }
    const doc = c.req.valid('json') as unknown as DocInput;
    const fld = idFieldOf(col);
    if (typeof doc[fld] !== 'string' || (doc[fld] as string).length === 0) {
      return c.json({ error: 'Invalid document payload', details: { [fld]: ['Required'] } }, 400);
    }
    if (doc[fld] !== c.req.param('id')) {
      return c.json({ error: 'Body id does not match the URL' }, 400);
    }
    if (col.scope && typeof doc[col.scope.field] !== 'string') {
      const q = c.req.query('scope');
      if (!q) return c.json({ error: `Scoped collection '${key}' requires a scope query` }, 400);
      doc[col.scope.field] = q;
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
    let col: DocCollectionSpec;
    try {
      col = requireSpec(key);
    } catch {
      return c.json({ error: 'Unknown collection', collection: key }, 404);
    }
    let scope: string | undefined;
    try {
      scope = requireScopeQuery(c, col);
    } catch (err) {
      if (err instanceof WorkflowError) return c.json({ error: err.message }, 400);
      throw err;
    }
    try {
      const merged = await patchDoc(getDb(c), key, c.req.param('id'), c.req.valid('json') as unknown as DocInput, scope);
      return c.json(merged ?? {});
    } catch (err) {
      if (err instanceof WorkflowError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  router.delete('/:collection/:id', async (c) => {
    let col: DocCollectionSpec;
    try {
      col = requireSpec(c.req.param('collection'));
    } catch {
      return c.json({ error: 'Unknown collection', collection: c.req.param('collection') }, 404);
    }
    let scope: string | undefined;
    try {
      scope = requireScopeQuery(c, col);
    } catch (err) {
      if (err instanceof WorkflowError) return c.json({ error: err.message }, 400);
      throw err;
    }
    try {
      const gone = await softDeleteDoc(getDb(c), col.key, c.req.param('id'), scope);
      return gone ? c.json({ ok: true }) : c.json({ error: 'Document not found' }, 404);
    } catch (err) {
      if (err instanceof WorkflowError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  router.post('/batch', validator('json', validateJson(batchSchema, 'Invalid batch payload')), async (c) => {
    const applied: { collection: string; id: string }[] = [];
    try {
      for (const op of c.req.valid('json').ops) {
        requireSpec(op.collection);
        if (op.op === 'put') {
          await putDoc(getDb(c), op.collection, op.doc as DocInput);
          applied.push({ collection: op.collection, id: docIdOf(requireSpec(op.collection), op.doc as DocInput) });
        } else {
          await softDeleteDoc(getDb(c), op.collection, op.id, op.scope);
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
