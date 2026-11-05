import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createResource, RESOURCE_TTL_MS } from '../src/resource';
import { useResource } from '../src/resource-react';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useResource', () => {
  it('starts loading on a cold resource and exposes the loaded value', async () => {
    const gate = deferred<string[]>();
    const resource = createResource<string[]>({
      load: () => gate.promise,
      storageKey: null,
      ttlMs: RESOURCE_TTL_MS,
    });
    const { result } = renderHook(() => useResource(resource));
    expect(result.current.loading).toBe(true);
    expect(result.current.value).toBeNull();

    await act(async () => {
      gate.resolve(['a']);
      await gate.promise;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.value).toEqual(['a']);
  });

  it('skips loading on a warm resource', () => {
    const load = vi.fn(async () => ['warm']);
    const resource = createResource<string[]>({ load, storageKey: null, ttlMs: RESOURCE_TTL_MS });
    resource.write(['already-here']);
    const { result } = renderHook(() => useResource(resource));
    expect(result.current.loading).toBe(false);
    expect(result.current.value).toEqual(['already-here']);
  });

  it('turns loading off when the load fails and keeps the last value', async () => {
    let rejectLoad!: (reason: unknown) => void;
    const resource = createResource<string[]>({
      load: () =>
        new Promise<string[]>((_resolve, reject) => {
          rejectLoad = reject;
        }),
      storageKey: null,
      ttlMs: RESOURCE_TTL_MS,
    });
    resource.write(['kept']);
    const { result } = renderHook(() => useResource(resource));
    expect(result.current.value).toEqual(['kept']);

    await act(async () => {
      resource.refresh();
      rejectLoad(new Error('network down'));
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.value).toEqual(['kept']);
  });

  it('re-renders subscribers when the resource is written elsewhere', async () => {
    const resource = createResource<string[]>({
      load: async () => ['initial'],
      storageKey: null,
      ttlMs: RESOURCE_TTL_MS,
    });
    const { result } = renderHook(() => useResource(resource));
    await waitFor(() => expect(result.current.value).toEqual(['initial']));

    act(() => {
      resource.write(['from-outside']);
    });
    expect(result.current.value).toEqual(['from-outside']);
  });
});
