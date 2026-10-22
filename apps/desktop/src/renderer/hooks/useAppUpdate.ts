import { useCallback, useEffect } from "react";
import { usePolledRead } from "./usePolledRead";
import { useDesktopApi } from "./useDesktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";
import type { AppUpdateStatus } from "../types/desktopApi";

// THE ONLY THING AUTOMATIC UPDATES SHOW AN OPERATOR.
//
// Checking, downloading and verifying all happen in the main process with nothing on screen —
// see main/updater.ts. This hook exists for one moment: a new version is on disk, and somebody
// has to be asked whether to restart now.
//
// Deliberately silent about everything else. No "checking for updates" spinner, no "you are up
// to date", no download percentage in the operator's face, and nothing at all when a check
// fails — the ERP is working, and an update that has not arrived is not news. A factory PC
// should never make somebody think about this feature.
//
// Polled, not pushed: the preload bridge is invoke-only. Once a minute is far more often than a
// four-hourly check needs, and usePolledRead pauses while the window is hidden.
const POLL_INTERVAL_MS = 60_000;

/** Keyed so a poll that keeps reporting READY replaces its own notice instead of stacking. */
const UPDATE_NOTICE_KEY = "app-update-ready";


/**
 * The bridge's answer, checked before it is used.
 *
 * A type declaration is not a runtime guarantee (R25), and this one crosses a process boundary.
 * Only the fields this hook reads are checked.
 */
const isUpdateStatus = (value: unknown): value is AppUpdateStatus => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.phase === "string" && typeof record.currentVersion === "string";
};

/**
 * Watches for a downloaded update and offers the restart that installs it.
 *
 * Mounted once, at the application root. Returns nothing: the prompt is a notification, so
 * there is no markup for a caller to place.
 */
export const useAppUpdate = (): void => {
  const api = useDesktopApi();
  const { pushAction, push, dismiss } = useNotifications();

  // Adapts getUpdateStatus to usePolledRead's reply shape. `accepted: false` on a malformed
  // answer, which usePolledRead keeps quiet about after a good read — exactly the behaviour
  // wanted here, since a failed poll is not something to tell the floor about.
  const read = useCallback(async () => {
    const status = await api.getUpdateStatus();
    return isUpdateStatus(status) ? { accepted: true as const, value: status } : { accepted: false as const };
  }, [api]);

  const { value: status } = usePolledRead(read, { intervalMs: POLL_INTERVAL_MS, failed: "" });

  const install = useCallback(async () => {
    const outcome = await api.installUpdate();
    // Accepted means the application is closing to install, so there is nothing to show. Only a
    // refusal needs saying — and then the prompt goes, because pressing it again will not help.
    if (!outcome.accepted) {
      dismiss(UPDATE_NOTICE_KEY);
      push("error", copy.update.installRefused, outcome.reason);
    }
  }, [api, dismiss, push]);

  useEffect(() => {
    if (status?.phase !== "READY") return;
    pushAction(
      UPDATE_NOTICE_KEY,
      "success",
      copy.update.readyTitle,
      copy.update.readyBody(status.availableVersion ?? ""),
      { label: copy.update.restartNow, onClick: () => void install() }
    );
  }, [status?.phase, status?.availableVersion, pushAction, install]);

  // THE OTHER THING WORTH INTERRUPTING SOMEBODY FOR: this computer has stopped receiving
  // versions. Not a failed check — those stay silent — but days without a successful one (seven
  // normally, two for a refused credential, which never fixes itself). An expired token would
  // otherwise strand a PC on an old build with nothing anywhere on screen to say so.
  //
  // Shown to everyone, not only administrators: the person at the machine is the one who can
  // tell somebody, and on a factory PC that is rarely an administrator.
  useEffect(() => {
    if (status?.stalled !== true) return;
    // Keyed and sticky: it is a condition, not an event, and it stays until somebody fixes the
    // credential or the feed. The ✕ clears it for this session.
    push(
      "warning",
      copy.update.stalledTitle,
      copy.update.stalledBody(status.stalledDays ?? 0, status.reason ?? ""),
      0
    );
    // Deliberately keyed on `stalled` alone, so a changing day count does not re-raise it every
    // poll once somebody has dismissed it.
  }, [status?.stalled, push]);
};
