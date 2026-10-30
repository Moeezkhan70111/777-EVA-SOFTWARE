import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { isValidRawMaterialQrId } from "@erp/domain";
import { isCompleteQr, sanitizeScanInput } from "../../utils/qr";

// The scan box behind every embedded scanner — Upper Out on Store Out, Carton In on Store In,
// Receive Production. A hardware scanner types the whole code into whichever field has focus, often
// with no Enter, so the box:
//
//   * keeps the focus while it is armed (and takes it back after every result)
//   * submits as soon as the buffer looks like a complete label
//   * runs scans ONE AT A TIME: a scanner burst can fire the next code before the last movement
//     has committed, and two overlapping writes would each be judged against a store the other moved
//
// autoSubmit "scanner-burst" is for a box that is ALSO a manual entry field (Receive Production):
// a code that arrives at scanner speed still goes on its own, but one typed by hand is never sent
// half-typed — it waits for Enter or the Enter button — and if it is refused it is put back in the
// box, so the operator corrects it instead of typing it again.
//
// It decides nothing about what a scan means; onScan does. onScan may answer false for "refused".

/** Slower than this between two characters, and the code is being typed by hand. */
const HAND_TYPING_GAP_MS = 60;

interface UseScanBoxInput {
  armed: boolean;
  onScan: (code: string) => Promise<boolean | void>;
  /** Changes after every result, so the box takes the focus back. */
  refocusKey: number;
  /** "complete-label" (default): any complete-looking label goes. "scanner-burst": see above. */
  autoSubmit?: "complete-label" | "scanner-burst";
}

export interface ScanBox {
  inputRef: React.RefObject<HTMLInputElement | null>;
  inputVal: string;
  setInputVal: (value: string) => void;
  focusScanner: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Sends what is in the box now — the Enter button. */
  submit: () => void;
}

interface Queued {
  code: string;
  /** Typed by hand: put back in the box if refused. */
  typed: boolean;
}

export const useScanBox = ({ armed, onScan, refocusKey, autoSubmit = "complete-label" }: UseScanBoxInput): ScanBox => {
  const [inputVal, setInputValState] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const queueRef = useRef<Queued[]>([]);
  const processingRef = useRef(false);
  const valueRef = useRef("");
  const typedRef = useRef(false);
  const lastChangeRef = useRef(0);
  const focusScanner = useCallback(() => inputRef.current?.focus(), []);
  // Read when a scan finishes: a box disarmed meanwhile (the Store page switched mode) must not
  // take the focus back from the box that is armed now.
  const armedRef = useRef(armed);
  armedRef.current = armed;

  const setInputVal = useCallback((value: string) => {
    const now = Date.now();
    const previous = valueRef.current;
    // A box that starts again starts untyped; one character more after a human pause is typing.
    if (value.length <= 1 || previous.length === 0) typedRef.current = false;
    else if (value.length === previous.length + 1 && now - lastChangeRef.current > HAND_TYPING_GAP_MS) typedRef.current = true;
    lastChangeRef.current = now;
    valueRef.current = value;
    setInputValState(value);
  }, []);

  useEffect(() => {
    if (armed) focusScanner();
  }, [armed, refocusKey, focusScanner]);

  const drainQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift()!;
        const accepted = await onScan(next.code);
        // A refused hand-typed code goes back for correcting, unless something new was typed since.
        // It goes back AS typed, so it waits for Enter again instead of being sent straight back.
        if (accepted === false && next.typed && valueRef.current === "") {
          valueRef.current = next.code;
          typedRef.current = true;
          lastChangeRef.current = Date.now();
          setInputValState(next.code);
        }
      }
    } finally {
      processingRef.current = false;
      if (armedRef.current) focusScanner();
    }
  }, [focusScanner, onScan]);

  const submitScan = useCallback(
    (raw: string) => {
      const cleaned = sanitizeScanInput(raw);
      if (!cleaned || cleaned.length < 3) return;
      const typed = typedRef.current;
      setInputVal("");
      queueRef.current.push({ code: cleaned, typed });
      void drainQueue();
    },
    [drainQueue, setInputVal]
  );

  // A complete-looking label goes at once; anything else waits a beat for the rest of the burst.
  useEffect(() => {
    if (!inputVal || !armed) return;
    if (autoSubmit === "scanner-burst" && typedRef.current) return;
    const cleaned = sanitizeScanInput(inputVal);
    if (!cleaned) return;
    const complete = isValidRawMaterialQrId(cleaned) || isCompleteQr(cleaned);
    if (!complete && cleaned.length < 5) return;
    // Only if the box still holds this value: an effect left over from an earlier render can arm a
    // second timer for a code already sent (React may flush it after the first one fired), and
    // without this check that code would be sent twice.
    const timer = setTimeout(() => {
      if (sanitizeScanInput(valueRef.current) === cleaned) submitScan(cleaned);
    }, complete ? 40 : 120);
    return () => clearTimeout(timer);
  }, [inputVal, armed, submitScan, autoSubmit]);

  // Enter sends what is in the box NOW (valueRef), never the inputVal of the render this handler
  // came from. A scanner that types a code and Enter gives the box two ways to send it; on a busy PC
  // the auto-submit timer can send and clear the box before React re-renders, and the Enter that
  // follows lands on the previous render's handler, which still held the code -- one scan, sent
  // twice. Reading the same live value the timer reads makes the second one find an empty box.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitScan(valueRef.current);
      } else if (event.key === "Escape") {
        // Escape here clears the box and nothing else: it must not also reach the app-wide Escape,
        // which would leave the page (or, on the Store page, switch mode).
        event.preventDefault();
        event.stopPropagation();
        setInputVal("");
      }
    },
    [submitScan, setInputVal]
  );

  const submit = useCallback(() => submitScan(valueRef.current), [submitScan]);

  return { inputRef, inputVal, setInputVal, focusScanner, onKeyDown, submit };
};
