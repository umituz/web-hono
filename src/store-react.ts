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

  function useDbValue<T>(compute: () => T, keys: string[]): T {
    const [, force] = useState(0);
    const computeRef = useRef(compute);
    computeRef.current = compute;
    const valueRef = useRef<T>(compute());
    valueRef.current = computeRef.current();
    useEffect(() => store.subscribe(keys, () => force((v) => v + 1)), [keys.join(',')]);
    return valueRef.current;
  }

  function useCollection<K extends keyof Database & string>(key: K): Database[K] {
    const [, force] = useState(0);
    useEffect(() => store.subscribe([key], () => force((v) => v + 1)), [key]);
    return store.getDb()[key];
  }

  function useHydration(): { status: 'loading' | 'ready' | 'error'; error?: string; retry: () => void } {
    const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; error?: string }>({ status: 'loading' });
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
      let alive = true;
      setState({ status: 'loading' });
      store.ensureHydrated().then(
        () => {
          if (alive) setState({ status: 'ready' });
        },
        (err) => {
          if (alive) setState({ status: 'error', error: err instanceof Error ? err.message : 'Hydration failed' });
        },
      );
      return () => {
        alive = false;
      };
    }, [attempt]);

    const retry = useCallback(() => setAttempt((a) => a + 1), []);
    return { status: state.status, error: state.error, retry };
  }

  return { useQuery, useDbValue, useCollection, useHydration };
}
