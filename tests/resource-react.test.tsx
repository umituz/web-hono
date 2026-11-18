import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { RESOURCE_TTL_MS, createResource } from '../src/resource';
import { useResource } from '../src/resource-react';

describe('useResource', () => {
  it('exposes a load failure as error while keeping the stale value', async () => {
    let fail = false;
    const resource = createResource<string[]>({
      load: async () => {
        if (fail) throw new Error('boom');
        return ['a'];
      },
      storageKey: null,
      ttlMs: RESOURCE_TTL_MS,
    });
    const { result } = renderHook(() => useResource(resource));
    await waitFor(() => expect(result.current.value).toEqual(['a']));
    expect(result.current.error).toBeNull();
    fail = true;
    await act(async () => {
      await resource.refresh();
    });
    expect(result.current.value).toEqual(['a']);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.loading).toBe(false);
  });

  it('reports the error of a failing first load', async () => {
    const resource = createResource<number>({
      load: async () => {
        throw new Error('down');
      },
      storageKey: null,
      ttlMs: RESOURCE_TTL_MS,
    });
    const { result } = renderHook(() => useResource(resource));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.value).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('clears the error after a recovery refresh', async () => {
    let fail = true;
    const resource = createResource<string[]>({
      load: async () => {
        if (fail) throw new Error('boom');
        return ['a'];
      },
      storageKey: null,
      ttlMs: RESOURCE_TTL_MS,
    });
    const { result } = renderHook(() => useResource(resource));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    fail = false;
    await act(async () => {
      await resource.refresh();
    });
    expect(result.current.value).toEqual(['a']);
    expect(result.current.error).toBeNull();
  });
});
