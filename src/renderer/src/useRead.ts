import { useCallback, useEffect, useRef, useState } from 'react';

type Result<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A new query never renders a previous query's result, even before its effect starts. */
export function useRead<T>(query: () => Promise<T>, refreshVersion = 0) {
  const [version, setVersion] = useState(0);
  const requestedVersion = useRef(0);
  const [settled, setSettled] = useState<{ query: typeof query; result: Result<T> }>();
  const [latestValue, setLatestValue] = useState<T>();
  useEffect(() => {
    let current = true;
    query().then(
      value => {
        if (!current || version !== requestedVersion.current) return;
        setLatestValue(() => value);
        setSettled({ query, result: { status: 'ready', value } });
      },
      error => {
        if (current && version === requestedVersion.current) setSettled({ query, result: { status: 'error', message: errorMessage(error) } });
      },
    );
    return () => { current = false; };
  }, [query, version, refreshVersion]);
  const refresh = useCallback(() => setVersion(++requestedVersion.current), []);
  const result: Result<T> = settled?.query === query ? settled.result : { status: 'loading' };
  return { result, refresh, latestValue };
}
