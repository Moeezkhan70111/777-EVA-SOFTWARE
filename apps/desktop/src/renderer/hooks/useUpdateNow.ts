import { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../config/copy";
import { useOptionalNotifications, type NoticeKind } from "../state/NotificationsContext";
import type { AppUpdateStatus } from "../types/desktopApi";

// THE UPDATE BUTTON (owner, 11 Nov 2026): "click it, see if GitHub has a newer version, and if so update now".
//
// The automatic checks stay as they are (main/updater.ts: 90 s after launch, then every four hours). This only asks
// the same updater to check NOW (checkForUpdates), follows its download, and installs the moment it is on disk
// (installUpdate, which restarts 777 ERP). Pressed by a person, so restarting straight away is what they asked for.
//
// Every step is the main process's: this decides nothing about versions, files or signatures.

/** How often the download is followed while it runs. */
const FOLLOW_MS = 2_000;
/** A download that has not finished in this long is left to the automatic install on the next restart. */
const FOLLOW_LIMIT_MS = 45 * 60 * 1000;

export type UpdateNowState =
  | { readonly kind: "IDLE" }
  | { readonly kind: "CHECKING" }
  | { readonly kind: "DOWNLOADING"; readonly percent: number | null }
  | { readonly kind: "INSTALLING" };

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

const asStatus = (value: unknown): AppUpdateStatus | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record.phase === "string" && typeof record.currentVersion === "string" ? (value as AppUpdateStatus) : null;
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const useUpdateNow = (): { state: UpdateNowState; run: () => void; available: boolean } => {
  const bridge = readUpdateBridge();
  const notices = useOptionalNotifications();
  const push = useCallback((kind: NoticeKind, title: string, message?: string) => notices?.push(kind, title, message, 8000), [notices]);
  const [state, setState] = useState<UpdateNowState>({ kind: "IDLE" });
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const install = useCallback(async (version: string | undefined) => {
    if (!bridge) return;
    setState({ kind: "INSTALLING" });
    const outcome = await bridge.installUpdate();
    // Accepted: 777 ERP is closing to install, and opens again on the new version. Nothing more to say.
    if (!outcome.accepted) push("error", copy.update.installRefused, outcome.reason ?? copy.update.tryAgain(version ?? ""));
  }, [bridge, push]);

  /** Follows the download until it is on disk, then installs. */
  const follow = useCallback(async (first: AppUpdateStatus) => {
    if (!bridge) return;
    const started = Date.now();
    let status: AppUpdateStatus | null = first;
    while (alive.current && status?.phase === "DOWNLOADING" && Date.now() - started < FOLLOW_LIMIT_MS) {
      setState({ kind: "DOWNLOADING", percent: typeof status.percent === "number" ? status.percent : null });
      await pause(FOLLOW_MS);
      status = asStatus(await bridge.getUpdateStatus());
    }
    if (status?.phase === "READY") return install(status.availableVersion);
    if (status?.phase === "DOWNLOADING") push("info", copy.update.stillDownloadingTitle, copy.update.stillDownloadingBody);
    else push("error", copy.update.failedTitle, status?.reason ?? copy.update.failedBody);
  }, [bridge, install, push]);

  const answer = useCallback(async (status: AppUpdateStatus | null) => {
    switch (status?.phase) {
      case "READY": return install(status.availableVersion);
      case "DOWNLOADING": return follow(status);
      case "UP_TO_DATE": return push("success", copy.update.upToDateTitle, copy.update.upToDateBody(status.currentVersion));
      case "DISABLED": return push("warning", copy.update.offTitle, status.reason ?? copy.update.failedBody);
      default: return push("error", copy.update.failedTitle, status?.reason ?? copy.update.failedBody);
    }
  }, [follow, install, push]);

  const run = useCallback(() => {
    if (!bridge || busy.current) return;
    busy.current = true;
    setState({ kind: "CHECKING" });
    void (async () => {
      try {
        await answer(asStatus(await bridge.checkForUpdates()));
      } catch {
        push("error", copy.update.failedTitle, copy.update.failedBody);
      } finally {
        busy.current = false;
        if (alive.current) setState((current) => (current.kind === "INSTALLING" ? current : { kind: "IDLE" }));
      }
    })();
  }, [answer, bridge, push]);

  return { state, run, available: bridge !== null };
};
