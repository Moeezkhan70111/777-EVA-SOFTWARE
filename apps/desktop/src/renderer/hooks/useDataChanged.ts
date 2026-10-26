import { useEffect, useRef } from "react";
import { readDataChange, type DataKind } from "../../shared/dataChange";

// Reloads a screen when data it shows changes underneath it (shared/dataChange.ts).
//
// `onChange` runs once per burst: a sync applies many records in a few hundred milliseconds, and a
// screen should reload once after them, not once per record. Read defensively, like
// SyncStatusIndicator: a bridge without the subscription (an older preload, a test) means no
// announcements, never a crash.

type ChangeBridge = { onDataChanged: (listener: (change: unknown) => void) => () => void };

const readBridge = (): ChangeBridge | null => {
  const api = (globalThis as { desktop?: { api?: Partial<ChangeBridge> } }).desktop?.api;
  return typeof api?.onDataChanged === "function" ? (api as ChangeBridge) : null;
};

/** How long a burst of changes is collected before the screen reloads once. */
export const DATA_CHANGE_SETTLE_MS = 300;

export const useDataChanged = (kinds: readonly DataKind[], onChange: () => void): void => {
  const latest = useRef(onChange);
  latest.current = onChange;
  // A stable key, so a caller passing a fresh array each render does not resubscribe each render.
  const key = [...kinds].sort().join(",");

  useEffect(() => {
    const bridge = readBridge();
    if (bridge === null) return;
    const wanted = new Set(key.split(","));
    let timer: number | undefined;
    const stop = bridge.onDataChanged((message) => {
      const change = readDataChange(message);
      if (change === null || !change.kinds.some((kind) => wanted.has(kind))) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => latest.current(), DATA_CHANGE_SETTLE_MS);
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [key]);
};
