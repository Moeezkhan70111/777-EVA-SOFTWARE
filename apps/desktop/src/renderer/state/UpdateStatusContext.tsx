import React, { createContext, useCallback, useContext, useMemo } from "react";
import { usePolledRead } from "../hooks/usePolledRead";
import type { AppUpdateStatus } from "../types/desktopApi";

// THE UPDATE STATUS, read once for the whole window.
//
// Two things show it: the "Restart Now" notice (hooks/useAppUpdate.ts) and the Update button in
// the rail (features/navigation/UpdateButton.tsx). Both read it from here, so there is one poll,
// not two, and both always agree.
//
// Every five seconds while the window is visible (was a minute): a download that finishes shows
// "Restart to update" almost at once. It is an in-process read of a few fields in the main
// process (main/updater.ts), and an answer that has not changed changes nothing on screen.

const POLL_INTERVAL_MS = 5_000;

export interface UpdateStatusValue {
  /** The main process's answer, or null before the first one (or with no bridge). */
  readonly status: AppUpdateStatus | null;
  /** Reads it again now, e.g. straight after the Update button asked for a check. */
  readonly refresh: () => Promise<void>;
}

const UpdateStatusContext = createContext<UpdateStatusValue | null>(null);

/** The bridge's answer, checked before it is used (R25). Only the fields read are checked. */
export const isUpdateStatus = (value: unknown): value is AppUpdateStatus => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.phase === "string" && typeof record.currentVersion === "string";
};

/** Read defensively: an older preload, or a test without a bridge, gets no status, not a crash. */
const readStatusBridge = (): { getUpdateStatus: () => Promise<unknown> } | null => {
  const api = (globalThis as { desktop?: { api?: { getUpdateStatus?: unknown } } }).desktop?.api;
  return typeof api?.getUpdateStatus === "function" ? (api as { getUpdateStatus: () => Promise<unknown> }) : null;
};

const sameStatus = (previous: AppUpdateStatus, next: AppUpdateStatus): boolean => JSON.stringify(previous) === JSON.stringify(next);

export const UpdateStatusProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const read = useCallback(async () => {
    const bridge = readStatusBridge();
    if (bridge === null) return { accepted: false as const };
    const status = await bridge.getUpdateStatus();
    return isUpdateStatus(status) ? { accepted: true as const, value: status } : { accepted: false as const };
  }, []);

  // A failed poll keeps the last answer and says nothing: an update status is never news.
  const { value, reload } = usePolledRead(read, { intervalMs: POLL_INTERVAL_MS, failed: "", isSame: sameStatus });
  const context = useMemo(() => ({ status: value, refresh: reload }), [value, reload]);
  return <UpdateStatusContext.Provider value={context}>{children}</UpdateStatusContext.Provider>;
};

/** The shared status, or null outside the provider (a screen rendered on its own in a test). */
export const useUpdateStatus = (): UpdateStatusValue | null => useContext(UpdateStatusContext);
