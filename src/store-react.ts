/* React bindings for a createStore instance. The store is framework-free;
   apps that don't use React never import this entry. Binding pattern:

     const store = createStore(config);
     export const { useQuery, useDbValue } = makeStoreHooks(store); */

import { useCallback, useEffect, useRef, useState } from 'react';
import { REFETCH_ALL, type createStore } from './store';

export interface QueryResult<T> {
  data: T | undefined;
  status: 'loading' | 'success' | 'error';
  error?: string;
  refetch: () => void;
}

export type Store<Database extends object> = ReturnType<typeof createStore<Database>>;

export function makeStoreHooks<Database extends object>(store: Store<Database>) {
  /** Async queries with loading/error states; re-runs when the underlying
   *  collections change (via the store's pub/sub) or when the key changes. */
  function useQuery<T>(key: unknown[], fetcher: () => Promise<T>, enabled = true): QueryResult<T> {
    const keyStr = JSON.stringify(key);
    const fetcherRef = useRef(fetcher);
    fetcherRef.current = fetcher;

    const [tick, setTick] = useState(0);
    const [state, setState] = useState<{ data?: T; status: 'loading' | 'success' | 'error'; error?: string }>({
      status: 'loading',
    });
    const requestId = useRef(0);

    useEffect(() => {
      if (!enabled) return;
      const id = ++requestId.current;
      let alive = true;
      setState((s) => ({ ...s, status: 'loading' }));
      fetcherRef.current().then(
        (data) => {
          if (alive && id === requestId.current) setState({ data, status: 'success' });
        },
        (err) => {
          if (alive && id === requestId.current)
            setState({ data: undefined, status: 'error', error: err instanceof Error ? err.message : 'Request failed' });
        },
      );
      return () => {
        alive = false;
      };
    }, [keyStr, tick, enabled]);

    useEffect(() => {
      const keys: string[] = JSON.parse(keyStr);
      return store.subscribe([...keys, REFETCH_ALL], () => setTick((t) => t + 1));
    }, [keyStr]);

    const refetch = useCallback(() => setTick((t) => t + 1), []);
    return { data: state.data, status: state.status, error: state.error, refetch };
  }

  /** Non-promise variant for synchronous derived reads that should still
   *  refresh when collections change. */
  function useDbValue<T>(compute: () => T, keys: string[]): T {
    const [, force] = useState(0);
    const computeRef = useRef(compute);
    computeRef.current = compute;
    const valueRef = useRef<T>(compute());
    valueRef.current = computeRef.current();
    // deps: the joined key string — the subscription only changes when it does
    useEffect(() => store.subscribe(keys, () => force((v) => v + 1)), [keys.join(',')]);
    return valueRef.current;
  }

  return { useQuery, useDbValue };
}
