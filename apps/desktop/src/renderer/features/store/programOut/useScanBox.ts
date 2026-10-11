import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { isValidRawMaterialQrId } from "@erp/domain";
import { isCompleteQr, sanitizeScanInput } from "../../../utils/qr";

// The scan box behind every scanner on a machine program — Upper Out on Store Out, Carton In on
// Store In. A hardware scanner types the whole code into whichever field has focus, often with no
// Enter, so the box:
//
//   * keeps the focus while it is armed (and takes it back after every result)
//   * submits as soon as the buffer looks like a complete label
//   * runs scans ONE AT A TIME: a scanner burst can fire the next code before the last movement
//     has committed, and two overlapping writes would each be judged against a store the other moved
//
// It decides nothing about what a scan means; onScan does.

interface UseScanBoxInput {
  armed: boolean;
  onScan: (code: string) => Promise<void>;
  /** Changes after every result, so the box takes the focus back. */
  refocusKey: number;
}

export interface ScanBox {
  inputRef: React.RefObject<HTMLInputElement | null>;
  inputVal: string;
  setInputVal: (value: string) => void;
  focusScanner: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

export const useScanBox = ({ armed, onScan, refocusKey }: UseScanBoxInput): ScanBox => {
  const [inputVal, setInputVal] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const processingRef = useRef(false);
  const focusScanner = useCallback(() => inputRef.current?.focus(), []);

  useEffect(() => {
    if (armed) focusScanner();
  }, [armed, refocusKey, focusScanner]);

  const drainQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        await onScan(queueRef.current.shift()!);
      }
    } finally {
      processingRef.current = false;
      focusScanner();
    }
  }, [focusScanner, onScan]);

  const submitScan = useCallback(
    (raw: string) => {
      const cleaned = sanitizeScanInput(raw);
      if (!cleaned || cleaned.length < 3) return;
      setInputVal("");
      queueRef.current.push(cleaned);
      void drainQueue();
    },
    [drainQueue]
  );

  // A complete-looking label goes at once; anything else waits a beat for the rest of the burst.
  useEffect(() => {
    if (!inputVal || !armed) return;
    const cleaned = sanitizeScanInput(inputVal);
    if (!cleaned) return;
    const complete = isValidRawMaterialQrId(cleaned) || isCompleteQr(cleaned);
    if (!complete && cleaned.length < 5) return;
    const timer = setTimeout(() => submitScan(cleaned), complete ? 40 : 120);
    return () => clearTimeout(timer);
  }, [inputVal, armed, submitScan]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitScan(inputVal);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setInputVal("");
      }
    },
    [inputVal, submitScan]
  );

  return { inputRef, inputVal, setInputVal, focusScanner, onKeyDown };
};
