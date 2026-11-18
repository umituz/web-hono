import { describe, expect, it, vi } from 'vitest';
import { RESOURCE_TTL_MS, createResource } from '../src/resource';

function resourceWithLoad<T>(load: () => Promise<T>) {
  return createResource<T>({ load, storageKey: null, ttlMs: RESOURCE_TTL_MS });
}

describe('createResource', () => {
  it('loads, caches and returns the value', async () => {
    const resource = resourceWithLoad(async () => ['a']);
    await expect(resource.ensure()).resolves.toEqual(['a']);
    expect(resource.read()).toEqual(['a']);
    expect(resource.readError()).toBeNull();
  });

  it('keeps the stale value and reports the failure via readError', async () => {
    let fail = false;
    const resource = resourceWithLoad(async () => {
      if (fail) throw new Error('boom');
      return ['a'];
    });
    await resource.ensure();
    fail = true;
    await expect(resource.refresh()).resolves.toEqual(['a']);
    expect(resource.readError()).toBeInstanceOf(Error);
    expect(resource.readError()?.message).toBe('boom');
  });

  it('wraps non-error rejections', async () => {
    const resource = resourceWithLoad(async () => {
      throw 'nope';
    });
    await expect(resource.ensure()).resolves.toBeNull();
    expect(resource.readError()).toBeInstanceOf(Error);
    expect(resource.readError()?.message).toBe('nope');
  });

  it('clears the error after a successful load', async () => {
    let fail = true;
    const resource = resourceWithLoad(async () => {
      if (fail) throw new Error('boom');
      return ['a'];
    });
    await resource.ensure();
    expect(resource.readError()).not.toBeNull();
    fail = false;
    await resource.refresh();
    expect(resource.readError()).toBeNull();
    expect(resource.read()).toEqual(['a']);
  });

  it('clears the error on write', async () => {
    const resource = resourceWithLoad<string[]>(async () => {
      throw new Error('boom');
    });
    await resource.ensure();
    expect(resource.readError()).not.toBeNull();
    resource.write(['b']);
    expect(resource.readError()).toBeNull();
    expect(resource.read()).toEqual(['b']);
  });

  it('notifies subscribers when a load fails', async () => {
    const listener = vi.fn();
    const resource = resourceWithLoad(async () => {
      throw new Error('boom');
    });
    resource.subscribe(listener);
    await resource.ensure();
    expect(listener).toHaveBeenCalled();
  });

  it('resets value and error on clear', async () => {
    const resource = resourceWithLoad(async () => {
      throw new Error('boom');
    });
    await resource.ensure();
    resource.clear();
    expect(resource.read()).toBeNull();
    expect(resource.readError()).toBeNull();
  });

  it('persists through storage when a key is given', async () => {
    const first = createResource<string[]>({
      load: async () => ['stored'],
      storageKey: 'resource-test-key',
      ttlMs: RESOURCE_TTL_MS,
    });
    await first.ensure();
    const second = createResource<string[]>({
      load: async () => ['fresh'],
      storageKey: 'resource-test-key',
      decode: (stored) => (Array.isArray(stored) ? (stored as string[]) : null),
      ttlMs: RESOURCE_TTL_MS,
    });
    expect(second.read()).toEqual(['stored']);
    second.clear();
    expect(localStorage.getItem('resource-test-key')).toBeNull();
  });
});
