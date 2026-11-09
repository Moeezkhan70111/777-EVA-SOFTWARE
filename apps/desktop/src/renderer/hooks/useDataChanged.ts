import { useEffect, useRef } from "react";
import { DATA_CHANGE_TRACE_STAGE, readDataChange, type DataChange, type DataChangeTraceStage, type DataKind } from "../../shared/dataChange";

// Reloads a screen when data it shows changes underneath it (shared/dataChange.ts).
//
// `onChange` runs once per burst: a sync applies many records in a few hundred milliseconds, and a
// screen should reload once after them, not once per record. It is given the last change of the
// burst. Read defensively, like SyncStatusIndicator: a bridge without the subscription (an older
// preload, a test) means no announcements, never a crash.
//
// TRACING. A screen that names itself (`trace`) reports to app.log that it heard a change, under the
// change's id; it reports its own later steps with traceDataChange.

type ChangeBridge = { onDataChanged: (listener: (change: unknown) => void) => () => void };
type TraceBridge = { traceDataChange: (trace: unknown) => Promise<unknown> };

const desktopBridge = (): Record<string, unknown> | undefined =>
  (globalThis as { desktop?: { api?: Record<string, unknown> } }).desktop?.api;

const readBridge = (): ChangeBridge | null => {
  const api = desktopBridge();
  return typeof api?.onDataChanged === "function" ? (api as unknown as ChangeBridge) : null;
};

/** Writes one step of a screen's handling of a change to app.log. Silent without a bridge or an id. */
export const traceDataChange = (screen: string, id: string | undefined, stage: DataChangeTraceStage, detail?: string): void => {
  const api = desktopBridge();
  if (id === undefined || typeof api?.traceDataChange !== "function") return;
  (api as unknown as TraceBridge).traceDataChange({ id, screen, stage, detail }).catch(() => undefined);
};

/** How long a burst of changes is collected before the screen reloads once. */
export const DATA_CHANGE_SETTLE_MS = 150;

export const useDataChanged = (kinds: readonly DataKind[], onChange: (change: DataChange) => void, options: { trace?: string } = {}): void => {
  const latest = useRef(onChange);
  latest.current = onChange;
  // A stable key, so a caller passing a fresh array each render does not resubscribe each render.
  const key = [...kinds].sort().join(",");
  const screen = options.trace;

  useEffect(() => {
    const bridge = readBridge();
    if (bridge === null) return;
    const wanted = new Set(key.split(","));
    let timer: number | undefined;
    const stop = bridge.onDataChanged((message) => {
      const change = readDataChange(message);
      if (change === null || !change.kinds.some((kind) => wanted.has(kind))) return;
      if (screen !== undefined) traceDataChange(screen, change.id, DATA_CHANGE_TRACE_STAGE.RECEIVED, change.kinds.join(","));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => latest.current(change), DATA_CHANGE_SETTLE_MS);
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [key, screen]);
};
