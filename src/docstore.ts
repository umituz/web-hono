import { Hono } from 'hono';
import { and, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
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
 *
 * Router config scales it from open admin surfaces to authenticated user
 * sync APIs: `scopeOf` derives the scope per request from the session (401
 * when it resolves null, replacing the `?scope=` query), `routeKeys`
 * allowlists which collections the router serves (others 404 as unknown,
 * staying motor-only), `onPut`/`onPatch` shape writes (server-owned fields,
 * deep merges), and `bulkBatch` runs the batch as grouped bulk writes that
 * keep large syncs inside the Workers subrequest budget.
 */

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
  transitions?: Readonly<Record<string, readonly string[]>>;
  /** Doc field the transitions guard reads. Default 'status'. */
  statusKey?: string;
  /** Write guard — see DocValidateFn. */
  validate?: DocValidateFn;
  idField?: string;
  scope?: DocScopeSpec;
  afterWrite?: DocAfterWriteFn;
}

export interface DocWriteHookArgs {
  key: string;
  /** Incoming document — hooks may rewrite server-owned fields in place. */
  doc: Record<string, unknown>;
  /** Current stored doc, or null when the write creates. */
  existing: Record<string, unknown> | null;
  /** Session scope when `scopeOf` resolved one (else undefined). */
  scope: string | undefined;
}

export interface DocPatchHookArgs {
  key: string;
  /** Incoming patch — hooks may rewrite it in place. */
  patch: Record<string, unknown>;
  existing: Doc | null;
  scope: string | undefined;
}

export interface DocStoreSpec<E extends ApiEnv = ApiEnv> {
  collections: readonly DocCollectionSpec[];
  /** Injectable db factory (tests, Hyperdrive). Default: per-request neon-http. */
  db?: (c: Context<{ Bindings: E }>) => CrudDb;
  /** POST /batch op cap. Default 2000. */
  maxBatch?: number;
  /** Restrict the generated ROUTER to these keys (authz allowlist — admin
   *  collections stay motor-only). Others answer 404 as if unknown.
   *  Default: every collection is routed. */
  routeKeys?: readonly string[];
  /** Session-derived scope for the router: resolves per request (better-auth
   *  user id, tenant id…). Null answers 401. When set it replaces the
   *  `?scope=` query: scoped collections are filtered by it and puts get it
   *  stamped, so clients cannot read or write another scope's rows. */
  scopeOf?: (c: Context<{ Bindings: E }>) => Promise<string | null>;
  /** Router-level put shaping (server-owned fields) before the write. */
  onPut?: (args: DocWriteHookArgs) => void | Promise<void>;
  /** Router-level patch shaping (deep merges, server-owned fields). */
  onPatch?: (args: DocPatchHookArgs) => void | Promise<void>;
  /** Batch runs as grouped bulk writes — one guard read + chunked upserts
   *  per collection instead of per-op putDoc — keeping large sync batches
   *  inside the Workers subrequest budget. Default: per-op. */
  bulkBatch?: boolean;
}

export class WorkflowError extends Error {}
export class UnknownCollectionError extends Error {}

/** Status machine check: staying put is always allowed. */
export function canTransition(map: Readonly<Record<string, readonly string[]>>, from: string, to: string): boolean {
  return from === to || (map[from] ?? []).includes(to);
}

/** ISO string → epoch ms; anything unparsable falls back to now. The
 *  epoch-0 instant (1970-01-01T00:00:00Z) parses to 0 and must stay 0 —
 *  a truthiness check would silently rewrite it to "now". */
export function epoch(iso: unknown): number {
  if (typeof iso !== 'string') return Date.now();
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.now() : ms;
}

function defaultDb<E extends ApiEnv>(c: Context<{ Bindings: E }>): CrudDb {
  return drizzle(neon(c.env.DATABASE_URL));
}

export function docStore<E extends ApiEnv = ApiEnv>(spec: DocStoreSpec<E>) {
  const byKey = new Map(spec.collections.map((col) => [col.key, col]));
  const getDb = spec.db ?? defaultDb<E>;
  const maxBatch = spec.maxBatch ?? 2000;
  const routeSet = spec.routeKeys === undefined ? null : new Set(spec.routeKeys);

  function collectionOf(key: string): DocCollectionSpec | undefined {
    return byKey.get(key);
  }

  function requireSpec(key: string): DocCollectionSpec {
    const col = byKey.get(key);
    if (!col) throw new UnknownCollectionError(`Unknown collection '${key}'`);
    return col;
  }

  function requireRoute(key: string): DocCollectionSpec {
    const col = requireSpec(key);
    if (routeSet !== null && !routeSet.has(key)) {
      throw new UnknownCollectionError(`Unknown collection '${key}'`);
    }
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

  function rowValues(col: DocCollectionSpec, doc: DocInput): Record<string, unknown> {
    const id = docIdOf(col, doc);
    const values: Record<string, unknown> = {
      id,
      // epoch() already falls back to now for unparsable input; the extra
      // `|| now` would rewrite a legitimate 0 (epoch-0 instant) to now.
      createdAt: epoch(doc.createdAt),
      updatedAt: epoch(doc.updatedAt),
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
    const values = rowValues(col, doc);
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
      const chunk = docs.slice(i, i + chunkSize).map((doc) => rowValues(col, doc));
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

  function requireScopeQuery(c: Context, col: DocCollectionSpec): string | undefined {
    if (!col.scope) return undefined;
    const q = c.req.query('scope');
    if (!q) throw new WorkflowError(`Scoped collection '${col.key}' requires a scope query`);
    return q;
  }

  function routeErrorResponse(c: Context, err: unknown): Response {
    if (err instanceof WorkflowError) return c.json({ error: err.message }, 400);
    if (err instanceof UnknownCollectionError) return c.json({ error: err.message }, 404);
    throw err;
  }

  async function resolveScope(c: Context): Promise<string | null | undefined> {
    if (spec.scopeOf === undefined) return undefined;
    return spec.scopeOf(c as unknown as Context<{ Bindings: E }>);
  }

  function dbOf(c: Context): CrudDb {
    return getDb(c as unknown as Context<{ Bindings: E }>);
  }

  const router = new Hono<{ Bindings: E }>();

  router.get('/:collection', async (c) => {
    try {
      const col = requireRoute(c.req.param('collection'));
      const scope = spec.scopeOf === undefined ? c.req.query('scope') : await resolveScope(c);
      if (scope === null) return c.json({ error: 'Authentication required' }, 401);
      return c.json(await listDocs(dbOf(c), col.key, scope));
    } catch (err) {
      return routeErrorResponse(c, err);
    }
  });

  router.get('/:collection/:id', async (c) => {
    try {
      const col = requireRoute(c.req.param('collection'));
      const scope = spec.scopeOf === undefined ? requireScopeQuery(c, col) : await resolveScope(c);
      if (scope === null) return c.json({ error: 'Authentication required' }, 401);
      const doc = await getDoc(dbOf(c), col.key, c.req.param('id'), scope);
      return doc ? c.json(doc) : c.json({ error: 'Document not found' }, 404);
    } catch (err) {
      return routeErrorResponse(c, err);
    }
  });

  router.put('/:collection/:id', validator('json', validateJson(docSchema, 'Invalid document payload')), async (c) => {
    try {
      const col = requireRoute(c.req.param('collection'));
      const doc = c.req.valid('json') as unknown as DocInput;
      const fld = idFieldOf(col);
      if (typeof doc[fld] !== 'string' || (doc[fld] as string).length === 0) {
        return c.json({ error: 'Invalid document payload', details: { [fld]: ['Required'] } }, 400);
      }
      if (doc[fld] !== c.req.param('id')) {
        return c.json({ error: 'Body id does not match the URL' }, 400);
      }
      const queryMode = spec.scopeOf === undefined;
      if (queryMode && col.scope && typeof doc[col.scope.field] !== 'string') {
        const q = c.req.query('scope');
        if (!q) return c.json({ error: `Scoped collection '${col.key}' requires a scope query` }, 400);
        doc[col.scope.field] = q;
      }
      const scope = queryMode ? undefined : await resolveScope(c);
      if (scope === null) return c.json({ error: 'Authentication required' }, 401);
      if (col.scope && scope !== undefined) doc[col.scope.field] = scope;
      const existing =
        spec.onPut === undefined
          ? undefined
          : await getDoc(dbOf(c), col.key, doc[fld] as string, col.scope ? scope : undefined);
      if (spec.onPut !== undefined) {
        await spec.onPut({ key: col.key, doc, existing: existing ?? null, scope: scope ?? undefined });
      }
      await putDoc(dbOf(c), col.key, doc);
      return c.json(doc as Doc, existing ? 200 : 201);
    } catch (err) {
      return routeErrorResponse(c, err);
    }
  });

  router.patch('/:collection/:id', validator('json', validateJson(patchSchema, 'Invalid patch payload')), async (c) => {
    try {
      const col = requireRoute(c.req.param('collection'));
      const scope = spec.scopeOf === undefined ? requireScopeQuery(c, col) : await resolveScope(c);
      if (scope === null) return c.json({ error: 'Authentication required' }, 401);
      const patch = c.req.valid('json') as unknown as DocInput;
      if (spec.onPatch !== undefined) {
        const existing = await getDoc(dbOf(c), col.key, c.req.param('id'), col.scope ? scope : undefined);
        await spec.onPatch({ key: col.key, patch, existing: existing ?? null, scope: scope ?? undefined });
      }
      const merged = await patchDoc(dbOf(c), col.key, c.req.param('id'), patch, col.scope ? scope : undefined);
      return c.json(merged ?? {});
    } catch (err) {
      return routeErrorResponse(c, err);
    }
  });

  router.delete('/:collection/:id', async (c) => {
    try {
      const col = requireRoute(c.req.param('collection'));
      const scope = spec.scopeOf === undefined ? requireScopeQuery(c, col) : await resolveScope(c);
      if (scope === null) return c.json({ error: 'Authentication required' }, 401);
      const gone = await softDeleteDoc(dbOf(c), col.key, c.req.param('id'), col.scope ? scope : undefined);
      return gone ? c.json({ ok: true }) : c.json({ error: 'Document not found' }, 404);
    } catch (err) {
      return routeErrorResponse(c, err);
    }
  });

  router.post('/batch', validator('json', validateJson(batchSchema, 'Invalid batch payload')), async (c) => {
    const batchError = (err: unknown, extra: Record<string, unknown> = {}): Response | null => {
      if (err instanceof WorkflowError) return c.json({ error: err.message, ...extra }, 400);
      if (err instanceof UnknownCollectionError) return c.json({ error: err.message, ...extra }, 404);
      return null;
    };

    const scope = await resolveScope(c);
    if (scope === null) return c.json({ error: 'Authentication required' }, 401);

    if (!spec.bulkBatch) {
      const applied: { collection: string; id: string }[] = [];
      try {
        for (const op of c.req.valid('json').ops) {
          const col = requireRoute(op.collection);
          if (op.op === 'put') {
            const doc = op.doc as DocInput;
            if (col.scope && scope !== undefined) doc[col.scope.field] = scope;
            await putDoc(dbOf(c), op.collection, doc);
            applied.push({ collection: op.collection, id: docIdOf(col, doc) });
          } else {
            const delScope = col.scope && scope === undefined ? op.scope : col.scope ? scope : op.scope;
            await softDeleteDoc(dbOf(c), op.collection, op.id, delScope);
            applied.push({ collection: op.collection, id: op.id });
          }
        }
      } catch (err) {
        const mapped = batchError(err, { applied: applied.length });
        if (mapped !== null) return mapped;
        throw err;
      }
      return c.json({ ok: true, applied: applied.length });
    }

    const db = dbOf(c);
    const putsByCollection = new Map<string, Map<string, DocInput>>();
    const delsByCollection = new Map<string, Set<string>>();
    try {
      for (const op of c.req.valid('json').ops) {
        const col = requireRoute(op.collection);
        if (op.op === 'del') {
          const dels = delsByCollection.get(op.collection) ?? new Set<string>();
          dels.add(op.id);
          delsByCollection.set(op.collection, dels);
          continue;
        }
        const doc = op.doc as DocInput;
        const id = docIdOf(col, doc);
        if (col.singletonId && id !== col.singletonId) {
          throw new WorkflowError(`Collection '${op.collection}' only accepts document id '${col.singletonId}'`);
        }
        if (col.scope && scope !== undefined) doc[col.scope.field] = scope;
        const puts = putsByCollection.get(op.collection) ?? new Map<string, DocInput>();
        puts.set(id, doc);
        putsByCollection.set(op.collection, puts);
      }
    } catch (err) {
      const mapped = batchError(err);
      if (mapped !== null) return mapped;
      throw err;
    }

    try {
      let applied = 0;
      for (const [key, docs] of putsByCollection) {
        const col = requireSpec(key);
        const existingById = new Map<string, DocInput>();
        if (col.scope !== undefined && col.scope !== null) {
          const needsExisting = col.transitions !== undefined || spec.onPut !== undefined;
          if (needsExisting && scope !== undefined) {
            const rows = await db
              .select({ id: col.table.id, data: col.table.data })
              .from(col.table)
              .where(and(eq(col.scope.column, scope), inArray(col.table.id, [...docs.keys()])));
            for (const row of rows) existingById.set(String(row.id), (row.data ?? {}) as DocInput);
          }
        } else if (spec.onPut !== undefined) {
          for (const id of docs.keys()) {
            const doc = await getDoc(db, key, id);
            if (doc !== undefined) existingById.set(id, doc);
          }
        }
        for (const doc of docs.values()) {
          const id = String(doc[idFieldOf(col)]);
          const existing = existingById.get(id) ?? null;
          if (spec.onPut !== undefined) await spec.onPut({ key, doc, existing, scope });
          if (col.transitions !== undefined && existing !== null) {
            const statusKey = col.statusKey ?? 'status';
            const from = existing[statusKey];
            const to = doc[statusKey];
            if (typeof from === 'string' && typeof to === 'string' && !canTransition(col.transitions, from, to)) {
              throw new WorkflowError(`Invalid ${key} transition ${from} → ${to}`);
            }
          }
        }
        applied += await putDocs(db, key, [...docs.values()]);
      }
      for (const [key, ids] of delsByCollection) {
        const col = requireSpec(key);
        const conds = [inArray(col.table.id, [...ids])];
        if (col.scope && scope !== undefined) conds.unshift(eq(col.scope.column, scope));
        await db
          .update(col.table)
          .set({ deletedAt: Date.now() } as never)
          .where(and(...conds));
        applied += ids.size;
      }
      return c.json({ ok: true, applied });
    } catch (err) {
      const mapped = batchError(err);
      if (mapped !== null) return mapped;
      throw err;
    }
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
