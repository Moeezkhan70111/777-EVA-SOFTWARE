import { useCallback, useEffect } from "react";
import { useDesktopApi } from "./useDesktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { useUpdateStatus } from "../state/UpdateStatusContext";
import { copy } from "../config/copy";

// THE ONE NOTICE AUTOMATIC UPDATES RAISE.
//
// Checking, downloading and verifying all happen in the main process. How far a download has got
// is shown quietly on the Update button in the rail (features/navigation/UpdateButton.tsx); this
// hook exists for one moment: a new version is on disk, and somebody has to be asked whether to
// restart now.
//
// Deliberately silent about everything else as a notice: no "checking", no "you are up to date",
// nothing when a check fails — the ERP is working, and an update that has not arrived is not news.
//
// The status comes from state/UpdateStatusContext.tsx, read every five seconds, so "Restart Now"
// appears within seconds of the download finishing.

/** Keyed so a status that keeps reporting READY replaces its own notice instead of stacking. */
const UPDATE_NOTICE_KEY = "app-update-ready";

/**
 * Watches for a downloaded update and offers the restart that installs it.
 *
 * Mounted once, through <AppUpdateWatcher />. Returns nothing: the prompt is a notification.
 */
export const useAppUpdate = (): void => {
  const api = useDesktopApi();
  const { pushAction, push, dismiss } = useNotifications();
  const status = useUpdateStatus()?.status ?? null;

  const install = useCallback(async () => {
    const outcome = await api.installUpdate();
    // Accepted means the application is closing to install, so there is nothing to show. Only a
    // refusal needs saying — and then the prompt goes, because pressing it again will not help.
    if (!outcome.accepted) {
      dismiss(UPDATE_NOTICE_KEY);
      push("error", copy.update.installRefused, outcome.reason);
    }
  }, [api, dismiss, push]);

  const ready = status?.phase === "READY";
  const readyVersion = status?.availableVersion ?? "";
  useEffect(() => {
    // A newer release replaced the downloaded one (main/updater.ts): the old prompt's Restart
    // would be refused, so it goes until the newer version is on disk.
    if (!ready) {
      dismiss(UPDATE_NOTICE_KEY);
      return;
    }
    pushAction(UPDATE_NOTICE_KEY, "success", copy.update.readyTitle, copy.update.readyBody(readyVersion), {
      label: copy.update.restartNow,
      onClick: () => void install(),
    });
  }, [ready, readyVersion, pushAction, dismiss, install]);

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
    push("warning", copy.update.stalledTitle, copy.update.stalledBody(status.stalledDays ?? 0, status.reason ?? ""), 0);
    // Deliberately keyed on `stalled` alone, so a changing day count does not re-raise it every
    // poll once somebody has dismissed it.
  }, [status?.stalled, push]);
};

/** Mounts useAppUpdate once, beside the application rather than inside it, so a status change re-renders nothing else. */
export const AppUpdateWatcher = (): null => {
  useAppUpdate();
  return null;
};
