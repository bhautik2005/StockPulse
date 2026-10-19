import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs an API loader and tracks loading / error / data for it.
 *
 * Every table in the console needs the same four things -- the rows, the
 * pagination meta, a spinner while waiting and something to show when it fails
 * -- so that logic lives here rather than being re-derived per page. The
 * `cancelled` flag matters: without it a slow first request can land after a
 * fast second one and overwrite fresh rows with stale ones.
 */
export function useApiResource(loader, deps = [], { skip = false } = {}) {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!skip);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (skip) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    loaderRef
      .current()
      .then((payload) => {
        if (cancelled) return;
        setData(payload?.data ?? null);
        setMeta(payload?.meta ?? null);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `deps` is the caller's list of things that should refetch. It is spread
    // deliberately: the loader is held in a ref so an inline arrow function
    // does not restart the request on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip, nonce, ...deps]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, meta, error, loading, reload, setData };
}

/** Delays a rapidly-changing value (a search box) before it drives a request. */
export function useDebouncedValue(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}