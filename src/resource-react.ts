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
