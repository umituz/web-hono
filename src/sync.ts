import { apiFetch } from './client';

export type SyncDoc = Record<string, unknown> & { id: string };

export type SyncCollections = Record<string, readonly SyncDoc[]>;

export type SyncPutOp = { op: 'put'; collection: string; doc: SyncDoc };

export type SyncDeleteOp = { op: 'del'; collection: string; id: string };

export type SyncOp = SyncPutOp | SyncDeleteOp;

export type StripFields = Record<string, readonly string[]>;

export function snapshotDocs(collections: SyncCollections, stripFields?: StripFields): Map<string, string> {
  const snap = new Map<string, string>();
  for (const [collection, docs] of Object.entries(collections)) {
    for (const doc of docs) {
      const fields = stripFields?.[collection];
      const wire = fields
        ? Object.fromEntries(Object.entries(doc).filter(([field]) => !fields.includes(field)))
        : doc;
      snap.set(`${collection}:${doc.id}`, JSON.stringify(wire));
    }
  }
  return snap;
}

export function diffOps(last: Map<string, string>, next: SyncCollections, stripFields?: StripFields): SyncOp[] {
  const current = snapshotDocs(next, stripFields);
  const ops: SyncOp[] = [];
  for (const [key, json] of current) {
    if (last.get(key) === json) continue;
    const separator = key.indexOf(':');
    const collection = key.slice(0, separator);
    const doc = next[collection]?.find((entry) => entry.id === key.slice(separator + 1));
    if (doc) ops.push({ op: 'put', collection, doc });
  }
  for (const key of last.keys()) {
    if (current.has(key)) continue;
    const separator = key.indexOf(':');
    ops.push({ op: 'del', collection: key.slice(0, separator), id: key.slice(separator + 1) });
  }
  return ops;
}

export async function pushOps(endpoint: string, ops: readonly SyncOp[], chunk: number): Promise<void> {
  for (let index = 0; index < ops.length; index += chunk) {
    await apiFetch(endpoint, { method: 'POST', json: { ops: ops.slice(index, index + chunk) } });
  }
}

export function pushOpsKeepalive(endpoint: string, ops: readonly SyncOp[], chunk: number, bodyLimit: number): void {
  for (let index = 0; index < ops.length; index += chunk) {
    const body = JSON.stringify({ ops: ops.slice(index, index + chunk) });
    if (body.length > bodyLimit) continue;
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  }
}
