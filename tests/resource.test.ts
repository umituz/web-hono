// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResource, RESOURCE_TTL_MS } from '../src/resource';

interface Row { id: string }

function rowsResource() {
  const loads = { count: 0 };
  const resource = createResource<Row[]>({
    load: async () => {
      loads.count += 1;
      return [{ id: `row-${loads.count}` }];
    },
    storageKey: 'test_rows_v1',
    decode: (stored) => (Array.isArray(stored) ? (stored as Row[]) : null),
    ttlMs: RESOURCE_TTL_MS,
  });
  return { loads, resource };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('createResource', () => {
  it('loads on first ensure and caches within TTL', async () => {
    const { loads, resource } = rowsResource();
    const first = await resource.ensure();
    expect(first).toEqual([{ id: 'row-1' }]);
    expect(loads.count).toBe(1);
    vi.advanceTimersByTime(RESOURCE_TTL_MS - 1);
    await resource.ensure();
    expect(loads.count).toBe(1);
  });

  it('reloads after the TTL expires', async () => {
    const { loads, resource } = rowsResource();
    await resource.ensure();
    vi.advanceTimersByTime(RESOURCE_TTL_MS);
    const second = await resource.ensure();
    expect(second).toEqual([{ id: 'row-2' }]);
    expect(loads.count).toBe(2);
  });

  it('shares a single in-flight load', async () => {
    const { loads, resource } = rowsResource();
    const [a, b] = await Promise.all([resource.ensure(), resource.ensure()]);
    expect(a).toEqual(b);
    expect(loads.count).toBe(1);
  });

  it('refresh() bypasses the TTL', async () => {
    const { loads, resource } = rowsResource();
    await resource.ensure();
    await resource.refresh();
    expect(loads.count).toBe(2);
  });

  it('keeps the last good value when a load fails', async () => {
    let fail = false;
    const resource = createResource<Row[]>({
      load: async () => {
        if (fail) throw new Error('network down');
        return [{ id: 'good' }];
      },
      storageKey: null,
      ttlMs: RESOURCE_TTL_MS,
    });
    await resource.ensure();
    fail = true;
    vi.advanceTimersByTime(RESOURCE_TTL_MS);
    const afterFailure = await resource.ensure();
    expect(afterFailure).toEqual([{ id: 'good' }]);
  });

  it('persists to storage and rehydrates through decode', async () => {
    const first = rowsResource();
    await first.resource.ensure();
    expect(localStorage.getItem('test_rows_v1')).toContain('row-1');
    const second = rowsResource();
    expect(second.resource.read()).toEqual([{ id: 'row-1' }]);
    vi.advanceTimersByTime(RESOURCE_TTL_MS);
    const fresh = await second.resource.ensure();
    expect(fresh).toEqual([{ id: 'row-1' }]);
    expect(second.loads.count).toBe(1);
  });

  it('ignores persisted data when decode rejects it', () => {
    localStorage.setItem('bad_shape_v1', JSON.stringify({ nope: true }));
    const resource = createResource<Row[]>({
      load: async () => [],
      storageKey: 'bad_shape_v1',
      decode: (stored) => (Array.isArray(stored) ? (stored as Row[]) : null),
      ttlMs: RESOURCE_TTL_MS,
    });
    expect(resource.read()).toBeNull();
  });

  it('notifies subscribers on write and clear', () => {
    const { resource } = rowsResource();
    const events: string[] = [];
    resource.subscribe(() => events.push('fired'));
    resource.write([{ id: 'local' }]);
    expect(resource.read()).toEqual([{ id: 'local' }]);
    resource.clear();
    expect(resource.read()).toBeNull();
    expect(events).toEqual(['fired', 'fired']);
    expect(localStorage.getItem('test_rows_v1')).toBeNull();
  });

  it('memory-only resources skip storage entirely', async () => {
    const resource = createResource<Row[]>({
      load: async () => [{ id: 'mem' }],
      storageKey: null,
      ttlMs: RESOURCE_TTL_MS,
    });
    await resource.ensure();
    expect(localStorage.length).toBe(0);
    expect(resource.read()).toEqual([{ id: 'mem' }]);
  });
});
