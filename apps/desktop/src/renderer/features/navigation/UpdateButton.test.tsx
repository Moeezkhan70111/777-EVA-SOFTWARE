import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copy } from "../../config/copy";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { UpdateStatusProvider } from "../../state/UpdateStatusContext";
import { NotificationCenter } from "../../components/layout/NotificationCenter";
import { UpdateButton } from "./UpdateButton";

// THE UPDATE BUTTON: check now; up to date says so; a newer version downloads and installs at once; updates that
// cannot work on this computer say why. It also shows the automatic update as it goes — found, downloading with
// the real percentage, ready to restart, failed with a retry. Asserted in words (R18).

const status = (phase: string, extra: Record<string, unknown> = {}) => ({ phase, currentVersion: "0.5.6", ...extra });

const withBridge = (api: Record<string, unknown>) => {
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  render(
    <NotificationsProvider>
      <UpdateStatusProvider>
        <UpdateButton />
        <NotificationCenter />
      </UpdateStatusProvider>
    </NotificationsProvider>
  );
};

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Update button", () => {
  it("says it is up to date when GitHub has nothing newer, and installs nothing", async () => {
    const installUpdate = vi.fn();
    withBridge({ checkForUpdates: vi.fn().mockResolvedValue(status("UP_TO_DATE")), getUpdateStatus: vi.fn().mockResolvedValue(status("IDLE")), installUpdate });
    await userEvent.click(await screen.findByRole("button", { name: copy.nav.rail.update }));
    expect(await screen.findByText(copy.update.upToDateBody("0.5.6"))).toBeInTheDocument();
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it("shows an automatic download's real percentage without being pressed", async () => {
    withBridge({
      checkForUpdates: vi.fn(),
      getUpdateStatus: vi.fn().mockResolvedValue(status("DOWNLOADING", { availableVersion: "0.5.7", percent: 42 })),
      installUpdate: vi.fn(),
    });
    expect(await screen.findByRole("button", { name: copy.nav.rail.updatePercent(42) })).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("says Restart to update as soon as the download is on disk, and installs when pressed", async () => {
    const installUpdate = vi.fn().mockResolvedValue({ accepted: true });
    const checkForUpdates = vi.fn();
    withBridge({ checkForUpdates, getUpdateStatus: vi.fn().mockResolvedValue(status("READY", { availableVersion: "0.5.7" })), installUpdate });
    await userEvent.click(await screen.findByRole("button", { name: copy.nav.rail.updateReady }));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    // Already on disk: nothing to check first.
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: copy.nav.rail.updateInstalling })).toBeInTheDocument();
  });

  it("offers a retry after a failed download, and the press asks the updater again", async () => {
    const checkForUpdates = vi.fn().mockResolvedValue(status("DOWNLOADING", { availableVersion: "0.5.7", percent: 0 }));
    withBridge({ checkForUpdates, getUpdateStatus: vi.fn().mockResolvedValue(status("ERROR", { failure: "DOWNLOAD", availableVersion: "0.5.7" })), installUpdate: vi.fn() });
    await userEvent.click(await screen.findByRole("button", { name: copy.nav.rail.updateFailed }));
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("a press during a download installs the moment the shared status says it is ready", async () => {
    // Faked from the start, so the five-second read is a timer this test can move.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const installUpdate = vi.fn().mockResolvedValue({ accepted: true });
    const getUpdateStatus = vi.fn().mockResolvedValue(status("IDLE"));
    const downloading = status("DOWNLOADING", { availableVersion: "0.5.7", percent: 10 });
    withBridge({ checkForUpdates: vi.fn().mockResolvedValue(downloading), getUpdateStatus, installUpdate });
    const button = await screen.findByRole("button", { name: copy.nav.rail.update });
    getUpdateStatus.mockResolvedValue(downloading);
    await user.click(button);
    expect(await screen.findByRole("button", { name: copy.nav.rail.updatePercent(10) })).toBeInTheDocument();
    expect(installUpdate).not.toHaveBeenCalled();

    // The next five-second read finds it on disk.
    getUpdateStatus.mockResolvedValue(status("READY", { availableVersion: "0.5.7" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
  });

  it("says why when updates cannot work on this computer", async () => {
    withBridge({
      checkForUpdates: vi.fn().mockResolvedValue(status("DISABLED", { reason: "This computer has no update credential." })),
      getUpdateStatus: vi.fn().mockResolvedValue(status("DISABLED")),
      installUpdate: vi.fn(),
    });
    await userEvent.click(await screen.findByRole("button", { name: copy.nav.rail.update }));
    expect(await screen.findByText("This computer has no update credential.")).toBeInTheDocument();
  });

  it("shows no button on a preload without the update calls", () => {
    withBridge({});
    expect(screen.queryByRole("button", { name: copy.nav.rail.update })).toBeNull();
  });
});
