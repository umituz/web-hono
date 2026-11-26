/* Field-level permission engine: role × entity × field → read/write.
 *
 * The matrix is DATA the host app owns (which fields exist, which roles
 * may see them); this module is the generic MACHINERY every host runs:
 * resolution, masking, write gating and the introspection surfaces a
 * Settings page or a "view as role" preview needs. Three design rules
 * are load-bearing:
 *
 * 1. MOST-RESTRICTED DEFAULT — a field absent from an entity's rule set
 *    is invisible (and unwritable) for every role. New columns must be
 *    granted explicitly, never leaked by omission.
 * 2. FLAT FIELD GRANULARITY — rules key on top-level row fields. A rule
 *    on `budget` masks the whole budget object; consumers never see a
 *    half-projection of a nested structure (a masked budget leaking its
 *    shape is worse than dropping it).
 * 3. READ ⊆ WRITE — a role can only write what it can read; `write`
 *    defaults to `read` and can only narrow further. A field nobody
 *    lists is a field nobody sees.
 *
 * Resolution is memoized per matrix × entity × role — the matrices are
 * static module constants, so the cache never needs invalidation and a
 * per-request lookup is one Map hit (the perf note the host pins). */

export interface FieldRule {
  /** Roles that may READ the field. Roles absent here get it dropped. */
  read: readonly string[];
  /** Roles that may WRITE the field through generic lanes (PATCH/CRUD).
   *  Defaults to `read` (visible implies writable); narrower lists mark
   *  visible-but-protected fields; `[]` marks immutable-through-API. */
  write?: readonly string[];
}

export type FieldMatrix = Record<string, FieldRuleSet>;
export interface FieldRuleSet {
  [field: string]: FieldRule;
}

export type RoleLike = string | null | undefined;

interface ResolvedEntity {
  /** Fields the role may read (Set membership in hot paths). */
  visible: Set<string>;
  /** Fields the role may write through generic lanes. */
  writable: Set<string>;
}

const EMPTY: ResolvedEntity = { visible: new Set<string>(), writable: new Set<string>() };

/* Matrix identity → (entity → role → resolution). Weak so a dropped
 * matrix drops its cache with it; strong inner maps live as long as
 * the app keeps the matrix referenced. */
const cache = new WeakMap<FieldMatrix, Map<string, Map<string, ResolvedEntity>>>();

function resolve(matrix: FieldMatrix, entity: string, role: string): ResolvedEntity {
  const rules = matrix[entity];
  if (!rules) return EMPTY;
  const fields = Object.keys(rules);
  const visible = new Set<string>();
  const writable = new Set<string>();
  for (const field of fields) {
    const rule = rules[field]!;
    if (rule.read.includes(role)) {
      visible.add(field);
      if ((rule.write ?? rule.read).includes(role)) writable.add(field);
    }
  }
  return { visible, writable };
}

function resolutionOf(matrix: FieldMatrix, entity: string, role: RoleLike): ResolvedEntity {
  if (!role) return EMPTY;
  let byEntity = cache.get(matrix);
  if (!byEntity) {
    byEntity = new Map();
    cache.set(matrix, byEntity);
  }
  let byRole = byEntity.get(entity);
  if (!byRole) {
    byRole = new Map();
    byEntity.set(entity, byRole);
  }
  let hit = byRole.get(role);
  if (!hit) {
    hit = resolve(matrix, entity, role);
    byRole.set(role, hit);
  }
  return hit;
}

/** May this role read this field? Absence from the matrix = no. */
export function canReadField(matrix: FieldMatrix, entity: string, field: string, role: RoleLike): boolean {
  return resolutionOf(matrix, entity, role).visible.has(field);
}

/** May this role write this field through a generic lane? Never truer
 *  than read. */
export function canWriteField(matrix: FieldMatrix, entity: string, field: string, role: RoleLike): boolean {
  return resolutionOf(matrix, entity, role).writable.has(field);
}

/** The fields of `entity` this role may read — a Settings matrix table
 *  or a "view as role" preview renders straight from this. */
export function visibleFieldsFor(matrix: FieldMatrix, entity: string, role: RoleLike): string[] {
  return [...resolutionOf(matrix, entity, role).visible];
}

/** The fields of `entity` this role may write — the honest "read-only"
 *  surface: everything visible minus this list is read-only. */
export function writableFieldsFor(matrix: FieldMatrix, entity: string, role: RoleLike): string[] {
  return [...resolutionOf(matrix, entity, role).writable];
}

/** Mask one row for a role: keys the role may not read are dropped
 *  whole (flat granularity — nested shapes never half-leak). Returns
 *  a NEW row; the input is never mutated. */
export function maskRow<T extends Record<string, unknown>>(matrix: FieldMatrix, entity: string, row: T, role: RoleLike): Record<string, unknown> {
  const { visible } = resolutionOf(matrix, entity, role);
  if (visible.size === 0) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    if (!visible.has(key)) continue;
    out[key] = row[key];
  }
  return out;
}

/** Mask a list of rows for a role (list endpoints). */
export function maskRows<T extends Record<string, unknown>>(matrix: FieldMatrix, entity: string, rows: T[], role: RoleLike): Record<string, unknown>[] {
  const { visible } = resolutionOf(matrix, entity, role);
  if (visible.size === 0) return rows;
  return rows.map((row) => maskRow(matrix, entity, row, role));
}

export interface PatchViolation {
  /** Patch keys the role may not write (empty = the patch is allowed). */
  fields: string[];
}

/** Check a PATCH body against the matrix: every key the role cannot
 *  write is named here — the caller refuses with a field-level 403 and
 *  its own audit row (a write refusal names the fields, never a bare
 *  404, because the row's existence is not the secret — the field is). */
export function patchViolations(matrix: FieldMatrix, entity: string, patch: Record<string, unknown>, role: RoleLike): PatchViolation {
  const { writable } = resolutionOf(matrix, entity, role);
  const fields: string[] = [];
  for (const key of Object.keys(patch)) {
    // Absence from the matrix entirely = masked for this role too
    // (most-restricted default), which also means not writable here.
    if (matrix[entity]?.[key] && !writable.has(key)) fields.push(key);
    if (!matrix[entity]?.[key]) fields.push(key);
  }
  return { fields };
}

/** The honest coverage counter: how many entities and fields a matrix
 *  actually rules over. Hosts pin this number so a silent matrix
 *  shrink (or a forgotten new field) is visible in review. */
export function matrixFootprint(matrix: FieldMatrix): { entities: number; fields: number } {
  let fields = 0;
  const entities = Object.keys(matrix).length;
  for (const entity of Object.keys(matrix)) fields += Object.keys(matrix[entity] ?? {}).length;
  return { entities, fields };
}
