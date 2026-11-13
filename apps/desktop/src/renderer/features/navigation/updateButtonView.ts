import { copy } from "../../config/copy";
import type { AppUpdateStatus } from "../../types/desktopApi";

// WHAT THE UPDATE BUTTON SAYS, from two inputs: what a press of it is doing right now (checking,
// restarting), and the main process's own update status (main/updater.ts). Nothing is invented:
// a percentage is shown only when electron-updater has reported one.
//
// The badge is for the slim rail, where only the icon shows: a symbol or a number, never colour
// alone (R18). The label and tooltip carry the words.

/** What a press of the button is doing. Anything else comes from the live status. */
export type UpdatePressState =
  | { readonly kind: "IDLE" }
  | { readonly kind: "CHECKING" }
  | { readonly kind: "INSTALLING" };

export type UpdateBadge = "PROGRESS" | "READY" | "FAILED";

export interface UpdateButtonView {
  readonly label: string;
  readonly tip: string;
  readonly badge: UpdateBadge | null;
  readonly badgeText: string;
}

const plain = (label: string, tip: string = copy.nav.rail.updateHint): UpdateButtonView => ({ label, tip, badge: null, badgeText: "" });

function downloadingView(status: AppUpdateStatus): UpdateButtonView {
  const version = status.availableVersion ?? "";
  const percent = typeof status.percent === "number" ? Math.round(status.percent) : null;
  if (percent === 0) {
    return { label: copy.nav.rail.updateAvailable, tip: copy.nav.rail.updateAvailableHint(version), badge: "PROGRESS", badgeText: "↓" };
  }
  if (percent === null) {
    return { label: copy.nav.rail.updateDownloading, tip: copy.nav.rail.updateDownloadingHint(version), badge: "PROGRESS", badgeText: "↓" };
  }
  return { label: copy.nav.rail.updatePercent(percent), tip: copy.nav.rail.updateDownloadingHint(version), badge: "PROGRESS", badgeText: `${String(percent)}%` };
}

export function updateButtonView(press: UpdatePressState, status: AppUpdateStatus | null): UpdateButtonView {
  if (press.kind === "INSTALLING") return plain(copy.nav.rail.updateInstalling);
  switch (status?.phase) {
    case "READY":
      return { label: copy.nav.rail.updateReady, tip: copy.nav.rail.updateReadyHint(status.availableVersion ?? ""), badge: "READY", badgeText: "↻" };
    case "DOWNLOADING":
      return downloadingView(status);
    case "ERROR":
      if (status.failure === "DOWNLOAD" && press.kind !== "CHECKING") {
        return { label: copy.nav.rail.updateFailed, tip: copy.nav.rail.updateFailedHint, badge: "FAILED", badgeText: "!" };
      }
      break;
    default:
      // An AUTOMATIC check (phase CHECKING, every two minutes) changes nothing here: "Checking…"
      // is said only for a check somebody pressed for, so the rail does not flash it all day.
      break;
  }
  return press.kind === "CHECKING" ? plain(copy.nav.rail.updateChecking) : plain(copy.nav.rail.update);
}
