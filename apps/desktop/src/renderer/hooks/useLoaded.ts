import { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../config/copy";

// The four states every async read needs (R12), for reads that answer `{ accepted, reason }`.
// Written for Machine Program; promoted here when the Contractor Ledger needed the same thing.

export interface Loaded<T> {
  value: T;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

type Answer = { accepted: boolean; reason?: string };

/**
 * Loads `read()` whenever `key` changes, keeping the four states a screen needs (R12). A null
 * `read` loads nothing. A slow answer for an old key never overwrites a newer one.
 */
export const useLoaded = <T, R extends Answer>(
  key: string,
  read: (() => Promise<R>) | null,
  pick: (answer: R) => T,
  initial: T
): Loaded<T> => {
  const [value, setValue] = useState<T>(initial);
  const [loading, setLoading] = useState(read !== null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(key);
  const readRef = useRef(read);
  const pickRef = useRef(pick);
  readRef.current = read;
  pickRef.current = pick;

  const reload = useCallback(async () => {
    const run = readRef.current;
    if (!run) return;
    const asked = key;
    latest.current = asked;
    setLoading(true);
    setError(null);
    try {
      const answer = await run();
      if (latest.current !== asked) return;
      if (!answer.accepted) throw new Error(answer.reason ?? copy.states.loadFailedBody);
      setValue(pickRef.current(answer));
    } catch (cause) {
      if (latest.current === asked) setError(cause instanceof Error ? cause.message : copy.states.loadFailedBody);
    } finally {
      if (latest.current === asked) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { value, loading, error, reload };
};

