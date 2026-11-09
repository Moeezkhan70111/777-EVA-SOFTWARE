import { useEffect, useRef } from "react";

// ONE PRESS OF SAVE, ONE REQUEST ID (migration 105). Manual Production's pattern, shared by Gatepass, the sale
// voucher and the cash voucher:
//
//   * the id stays the same until a DEFINITE answer, so a retry after a lost answer asks about the same document,
//     which the main process then returns instead of making a second one
//   * a press already in flight is refused synchronously (a ref, not state), so two clicks in one instant send once
//   * a press with no answer yet is written to localStorage. If the app closes before the answer comes, the
//     reopened screen asks the main process whether that press was recorded (useLeftoverRequest), instead of
//     guessing from what was typed: two identical gatepasses can both be intended.
//
// localStorage is a convenience here, never the record: unavailable, it only means a restart cannot say what
// happened to the last press. Every read and write is wrapped.

const remember = (key: string, id: string): void => {
  try { window.localStorage.setItem(key, id); } catch { /* storage unavailable: nothing to remember with */ }
};
const forget = (key: string): void => {
  try { window.localStorage.removeItem(key); } catch { /* storage unavailable */ }
};
const recall = (key: string): string | null => {
  try { return window.localStorage.getItem(key); } catch { return null; }
};

export interface RequestIdControl {
  /** Starts a press: its request id, or null when one is already in flight (the second click of a double click). */
  start(): string | null;
  /** A definite answer: the press is over and recorded either way. `renew` gives the next press a new id. */
  settle(options: { renew: boolean }): void;
  /** No answer came (thrown, lost): the next press asks about the same request. */
  unanswered(): void;
  /** A new document on screen: a new id, whatever happened before. */
  renew(): void;
}

export const useRequestId = (storageKey: string): RequestIdControl => {
  const id = useRef(crypto.randomUUID());
  const inFlight = useRef(false);

  return useRef<RequestIdControl>({
    start() {
      if (inFlight.current) return null;
      inFlight.current = true;
      remember(storageKey, id.current);
      return id.current;
    },
    settle({ renew }) {
      inFlight.current = false;
      forget(storageKey);
      if (renew) id.current = crypto.randomUUID();
    },
    unanswered() {
      inFlight.current = false;
    },
    renew() {
      id.current = crypto.randomUUID();
    },
  }).current;
};

/**
 * A press of Save the last session never heard back from: asks `find` whether it made a document, once, on
 * opening, and calls `onRecorded` with its name ("GP-000123") when it did. A press that made nothing is
 * simply forgotten: there is nothing to tell.
 */
export const useLeftoverRequest = (
  storageKey: string,
  find: (requestId: string) => Promise<{ accepted: boolean; saved: { id: string; label: string } | null }>,
  onRecorded: (label: string) => void
): void => {
  const findRef = useRef(find);
  findRef.current = find;
  const recordedRef = useRef(onRecorded);
  recordedRef.current = onRecorded;

  useEffect(() => {
    const leftover = recall(storageKey);
    if (!leftover) return;
    let alive = true;
    // Inside the chain, so a lookup that throws at once (an older bridge, a test) is caught like one that rejects.
    void Promise.resolve()
      .then(() => findRef.current(leftover))
      .then((answer) => {
        if (!answer.accepted) return; // not allowed to look, or the main process could not: keep it for next time
        forget(storageKey);
        if (alive && answer.saved) recordedRef.current(answer.saved.label);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [storageKey]);
};

/** The localStorage keys, one per screen. */
export const REQUEST_STORAGE_KEY = {
  GATEPASS: "erp.pendingRequest.gatepass",
  SALE_VOUCHER: "erp.pendingRequest.saleVoucher",
  CASH_VOUCHER: "erp.pendingRequest.cashVoucher",
} as const;
