// Where a refused leased write is announced (docs/37 section W).
//
// The desktop API wrapper (hooks/useDesktopApi.ts) reports every lease refusal here, before the
// caller sees the error at all. The notifications provider listens and shows it. So the operator is
// told who writes the domain on every path -- including a screen that swallows the error, shows its
// own generic text, or has no catch at all.

type Listener = (sentence: string) => void;

const listeners = new Set<Listener>();

/** Listens for refusals. Returns the way to stop. */
export const onLeaseRefusal = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const reportLeaseRefusal = (sentence: string): void => {
  for (const listener of listeners) listener(sentence);
};
