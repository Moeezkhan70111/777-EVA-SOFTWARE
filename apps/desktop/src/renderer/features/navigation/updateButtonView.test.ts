import { describe, expect, it } from "vitest";
import { copy } from "../../config/copy";
import type { AppUpdateStatus } from "../../types/desktopApi";
import { updateButtonView, type UpdatePressState } from "./updateButtonView";

// What the Update button says, for every state the updater can be in. Nothing invented: a
// percentage appears only when the updater reported one.

const idle: UpdatePressState = { kind: "IDLE" };
const status = (phase: AppUpdateStatus["phase"], extra: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({ phase, currentVersion: "0.5.9", ...extra });

describe("the Update button's words", () => {
  it("says Update when there is nothing to report", () => {
    for (const live of [null, status("IDLE"), status("UP_TO_DATE"), status("DISABLED")]) {
      expect(updateButtonView(idle, live)).toMatchObject({ label: copy.nav.rail.update, badge: null });
    }
  });

  it("says Checking only for a check somebody pressed for", () => {
    expect(updateButtonView({ kind: "CHECKING" }, status("IDLE")).label).toBe(copy.nav.rail.updateChecking);
    expect(updateButtonView({ kind: "CHECKING" }, status("CHECKING")).label).toBe(copy.nav.rail.updateChecking);
  });

  it("does not flash Checking during an automatic background check", () => {
    expect(updateButtonView(idle, status("CHECKING"))).toMatchObject({ label: copy.nav.rail.update, badge: null });
  });

  it("keeps showing a ready download through a background check", () => {
    // main/updater.ts keeps READY during a recheck; a stray CHECKING must not hide Restart either.
    expect(updateButtonView(idle, status("READY", { availableVersion: "0.6.0" })).label).toBe(copy.nav.rail.updateReady);
  });

  it("says Update available the moment a version is found, before any bytes arrive", () => {
    const view = updateButtonView(idle, status("DOWNLOADING", { availableVersion: "0.6.0", percent: 0 }));
    expect(view).toMatchObject({ label: copy.nav.rail.updateAvailable, badge: "PROGRESS", badgeText: "↓" });
    expect(view.tip).toContain("0.6.0");
  });

  it("shows the real percentage while downloading", () => {
    expect(updateButtonView(idle, status("DOWNLOADING", { availableVersion: "0.6.0", percent: 44.6 }))).toMatchObject({
      label: copy.nav.rail.updatePercent(45),
      badge: "PROGRESS",
      badgeText: "45%",
    });
  });

  it("says Downloading without a number when the updater has not reported one", () => {
    expect(updateButtonView(idle, status("DOWNLOADING", { availableVersion: "0.6.0" }))).toMatchObject({ label: copy.nav.rail.updateDownloading, badgeText: "↓" });
  });

  it("says Restart to update once the download is on disk", () => {
    const view = updateButtonView(idle, status("READY", { availableVersion: "0.6.0" }));
    expect(view).toMatchObject({ label: copy.nav.rail.updateReady, badge: "READY", badgeText: "↻" });
    expect(view.tip).toContain("0.6.0");
  });

  it("offers a retry when a download failed, but stays quiet about a failed check", () => {
    expect(updateButtonView(idle, status("ERROR", { failure: "DOWNLOAD" }))).toMatchObject({ label: copy.nav.rail.updateFailed, badge: "FAILED", badgeText: "!" });
    expect(updateButtonView(idle, status("ERROR", { failure: "CHECK" }))).toMatchObject({ label: copy.nav.rail.update, badge: null });
    expect(updateButtonView({ kind: "CHECKING" }, status("ERROR", { failure: "DOWNLOAD" })).label).toBe(copy.nav.rail.updateChecking);
  });

  it("says Restarting once an install has been asked for, whatever the status says", () => {
    expect(updateButtonView({ kind: "INSTALLING" }, status("READY", { availableVersion: "0.6.0" })).label).toBe(copy.nav.rail.updateInstalling);
  });
});
