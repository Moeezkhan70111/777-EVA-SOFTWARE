import { useCallback, useEffect, useRef, useState } from "react";

// A read kept current without anyone pressing Refresh — the stations' activity lists (Receive
// Production, Upper Move Out). The app has no push channel, so it polls:
//
//   * on mount, and whenever `read` changes (another machine, another page): the old value is
//     dropped at once, so one machine's rows never show under another's name
//   * every `intervalMs` while the window is visible; paused while hidden, stopped on unmount
//   * on reload() — after each scan the screen makes
//
// The value is always the main process's answer; nothing is added ahead of it. A refresh that
// fails after a good one keeps what was shown and says so (`stale`), rather than blanking it.

export type PolledReply<T> = { accepted: true; value: T } | { accepted: false; reason?: string };

export interface PolledRead<T> {
  value: T | null;
  loading: boolean;
  /** The first load failed: nothing to show. */
  error: string | null;
  /** A refresh after a good load failed: what is shown may be out of date. */
  stale: boolean;
  reload: () => Promise<void>;
}

export const usePolledRead = <T>(read: () => Promise<PolledReply<T>>, options: { intervalMs: number; failed: string }): PolledRead<T> => {
  const { intervalMs, failed } = options;
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const loadedRef = useRef(false);
  const readRef = useRef(read);

  const reload = useCallback(async () => {
    const asked = read;
    try {
      const reply = await asked();
      if (readRef.current !== asked) return; // the screen has moved on to another read
      if (!reply.accepted) throw new Error(reply.reason ?? failed);
      setValue(reply.value);
      setError(null);
      setStale(false);
      loadedRef.current = true;
    } catch (cause) {
      if (readRef.current !== asked) return;
      if (loadedRef.current) setStale(true);
      else setError(cause instanceof Error && cause.message ? cause.message : failed);
    } finally {
      if (readRef.current === asked) setLoading(false);
    }
  }, [read, failed]);

  useEffect(() => {
    readRef.current = read;
    loadedRef.current = false;
    setValue(null);
    setError(null);
    setStale(false);
    setLoading(true);
    void reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [read, reload, intervalMs]);

  return { value, loading, error, stale, reload };
};
