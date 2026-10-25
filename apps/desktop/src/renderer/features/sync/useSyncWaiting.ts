import { useCallback } from "react";
import { usePolledRead, type PolledRead } from "../../hooks/usePolledRead";
import { copy } from "../../config/copy";
import type { SyncReply, SyncWaiting } from "../../types/desktopApi";
import { isSyncWaiting } from "./syncWaiting";

// What this computer is waiting on, kept current. A local read, no network: polled every 30
// seconds while the window is visible, about twice per sync pass.
//
// Read defensively rather than through useDesktopApi, like SyncStatusIndicator: the app-wide
// notice renders on every screen, so an older preload without the channel, or a test without a
// bridge, must leave it showing nothing rather than crash the screen.

const POLL_INTERVAL_MS = 30_000;

type WaitingBridge = { getSyncWaiting: () => Promise<SyncReply<unknown>> };

const readBridge = (): WaitingBridge | null => {
  const api = (globalThis as { desktop?: { api?: Partial<WaitingBridge> } }).desktop?.api;
  return typeof api?.getSyncWaiting === "function" ? (api as WaitingBridge) : null;
};

export const useSyncWaiting = (): PolledRead<SyncWaiting> => {
  const read = useCallback(async (): Promise<SyncReply<SyncWaiting>> => {
    const bridge = readBridge();
    if (bridge === null) return { accepted: false };
    const reply = await bridge.getSyncWaiting();
    if (!reply.accepted) return reply;
    return isSyncWaiting(reply.value) ? { accepted: true, value: reply.value } : { accepted: false, reason: copy.syncWaiting.hereFailed };
  }, []);
  return usePolledRead(read, { intervalMs: POLL_INTERVAL_MS, failed: copy.syncWaiting.hereFailed });
};
