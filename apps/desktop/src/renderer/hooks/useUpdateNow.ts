import { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../config/copy";
import { useOptionalNotifications, type NoticeKind } from "../state/NotificationsContext";
import { isUpdateStatus, useUpdateStatus } from "../state/UpdateStatusContext";
import type { UpdatePressState } from "../features/navigation/updateButtonView";
import type { AppUpdateStatus } from "../types/desktopApi";

// THE UPDATE BUTTON (owner, 11 Nov 2026): "click it, see if GitHub has a newer version, and if so update now".
//
// The automatic checks run on their own (main/updater.ts: 15 s after launch, then every two minutes). A press asks
// the same updater to check NOW (checkForUpdates). If a version is already on disk it installs at once; if one is
// downloading, the press is remembered and the install happens the moment the shared status
// (state/UpdateStatusContext.tsx) reports it READY. Pressed by a person, so restarting straight away is what they
// asked for. With a download failed, a press is the retry.
//
// Every step is the main process's: this decides nothing about versions, files or signatures.

type UpdateBridge = {
  checkForUpdates: () => Promise<unknown>;
  getUpdateStatus: () => Promise<unknown>;
  installUpdate: () => Promise<{ accepted: boolean; reason?: string }>;
};

/** The three bridge calls, or null on an older preload or a test without a bridge: then there is no button. */
export const readUpdateBridge = (): UpdateBridge | null => {
  const api = (globalThis as { desktop?: { api?: Partial<UpdateBridge> } }).desktop?.api;
  if (typeof api?.checkForUpdates !== "function" || typeof api.getUpdateStatus !== "function" || typeof api.installUpdate !== "function") return null;
  return api as UpdateBridge;
};

export interface UpdateNow {
  /** What a press is doing. */
  readonly press: UpdatePressState;
  /** The live status every screen shares, or null before the first read. */
  readonly status: AppUpdateStatus | null;
  readonly run: () => void;
  readonly available: boolean;
}

export const useUpdateNow = (): UpdateNow => {
  const bridge = readUpdateBridge();
  const shared = useUpdateStatus();
  const status = shared?.status ?? null;
  const notices = useOptionalNotifications();
  const push = useCallback((kind: NoticeKind, title: string, message?: string) => notices?.push(kind, title, message, 8000), [notices]);
  const [press, setPress] = useState<UpdatePressState>({ kind: "IDLE" });
  const busy = useRef(false);
  /** A press found a download running: install the moment it is on disk. */
  const installWhenReady = useRef(false);

  const install = useCallback(async (version: string | undefined) => {
    if (!bridge) return;
    installWhenReady.current = false;
    setPress({ kind: "INSTALLING" });
    const outcome = await bridge.installUpdate();
    // Accepted: 777 ERP is closing to install, and opens again on the new version. Nothing more to say.
    if (!outcome.accepted) {
      setPress({ kind: "IDLE" });
      push("error", copy.update.installRefused, outcome.reason ?? copy.update.tryAgain(version ?? ""));
    }
  }, [bridge, push]);

  // Follows a download a press found running, through the shared status.
  useEffect(() => {
    if (!installWhenReady.current || status === null) return;
    if (status.phase === "READY") {
      void install(status.availableVersion);
    } else if (status.phase === "ERROR") {
      installWhenReady.current = false;
      push("error", copy.update.failedTitle, status.reason ?? copy.update.failedBody);
    }
  }, [status, install, push]);

  const answer = useCallback(async (checked: AppUpdateStatus | null) => {
    switch (checked?.phase) {
      case "READY": return install(checked.availableVersion);
      case "DOWNLOADING":
        // Without the shared status nothing would follow it; it still installs on the next quit.
        if (shared === null) return push("info", copy.update.stillDownloadingTitle, copy.update.stillDownloadingBody);
        installWhenReady.current = true;
        return;
      case "UP_TO_DATE": return push("success", copy.update.upToDateTitle, copy.update.upToDateBody(checked.currentVersion));
      case "DISABLED": return push("warning", copy.update.offTitle, checked.reason ?? copy.update.failedBody);
      default: return push("error", copy.update.failedTitle, checked?.reason ?? copy.update.failedBody);
    }
  }, [install, push, shared]);

  const run = useCallback(() => {
    if (!bridge || busy.current) return;
    if (status?.phase === "READY") {
      void install(status.availableVersion);
      return;
    }
    busy.current = true;
    setPress({ kind: "CHECKING" });
    void (async () => {
      try {
        const checked = await bridge.checkForUpdates();
        await shared?.refresh();
        await answer(isUpdateStatus(checked) ? checked : null);
      } catch {
        push("error", copy.update.failedTitle, copy.update.failedBody);
      } finally {
        busy.current = false;
        setPress((current) => (current.kind === "INSTALLING" ? current : { kind: "IDLE" }));
      }
    })();
  }, [answer, bridge, install, push, shared, status]);

  return { press, status, run, available: bridge !== null };
};
