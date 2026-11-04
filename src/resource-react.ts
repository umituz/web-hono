/* React binding for a createResource instance. The resource is
   framework-free; apps that don't use React never import this entry.
   Binding pattern:

     const plans = createResource({ load, storageKey: null, ttlMs: RESOURCE_TTL_MS });
     const { value, loading } = useResource(plans); */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Resource } from './resource';

export interface ResourceResult<T> {
  value: T | null;
  loading: boolean;
}

export function useResource<T>(resource: Resource<T>): ResourceResult<T> {
  const value = useSyncExternalStore(
    (onChange) => resource.subscribe(onChange),
    () => resource.read(),
    () => resource.read(),
  );
  const [loading, setLoading] = useState(resource.read() === null);

  useEffect(() => {
    if (resource.read() !== null) setLoading(false);
    let alive = true;
    resource
      .ensure()
      .catch(() => null)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [resource]);

  return { value, loading };
}
