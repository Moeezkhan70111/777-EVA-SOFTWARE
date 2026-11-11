import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copy } from "../../config/copy";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { NotificationCenter } from "../../components/layout/NotificationCenter";
import { UpdateButton } from "./UpdateButton";

// THE UPDATE BUTTON: check now; up to date says so; a newer version downloads and installs at once; updates that
// cannot work on this computer say why. Asserted in words (R18).

const status = (phase: string, extra: Record<string, unknown> = {}) => ({ phase, currentVersion: "0.5.6", ...extra });

const withBridge = (api: Record<string, unknown>) => {
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  render(<NotificationsProvider><UpdateButton /><NotificationCenter /></NotificationsProvider>);
};

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
  vi.restoreAllMocks();
});

describe("Update button", () => {
  it("says it is up to date when GitHub has nothing newer, and installs nothing", async () => {
    const installUpdate = vi.fn();
    withBridge({ checkForUpdates: vi.fn().mockResolvedValue(status("UP_TO_DATE")), getUpdateStatus: vi.fn(), installUpdate });
    await userEvent.click(screen.getByRole("button", { name: copy.nav.rail.update }));
    expect(await screen.findByText(copy.update.upToDateBody("0.5.6"))).toBeInTheDocument();
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it("follows a download and installs it the moment it is on disk", async () => {
    const installUpdate = vi.fn().mockResolvedValue({ accepted: true });
    const getUpdateStatus = vi.fn().mockResolvedValue(status("READY", { availableVersion: "0.5.7" }));
    withBridge({ checkForUpdates: vi.fn().mockResolvedValue(status("DOWNLOADING", { availableVersion: "0.5.7", percent: 42 })), getUpdateStatus, installUpdate });
    await userEvent.click(screen.getByRole("button", { name: copy.nav.rail.update }));
    expect(await screen.findByRole("button", { name: copy.nav.rail.updatePercent(42) })).toBeInTheDocument();
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(screen.getByRole("button", { name: copy.nav.rail.updateInstalling })).toBeInTheDocument();
  });

  it("installs at once when a version is already downloaded", async () => {
    const installUpdate = vi.fn().mockResolvedValue({ accepted: true });
    withBridge({ checkForUpdates: vi.fn().mockResolvedValue(status("READY", { availableVersion: "0.5.7" })), getUpdateStatus: vi.fn(), installUpdate });
    await userEvent.click(screen.getByRole("button", { name: copy.nav.rail.update }));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
  });

  it("says why when updates cannot work on this computer", async () => {
    withBridge({
      checkForUpdates: vi.fn().mockResolvedValue(status("DISABLED", { reason: "This computer has no update credential." })),
      getUpdateStatus: vi.fn(),
      installUpdate: vi.fn(),
    });
    await userEvent.click(screen.getByRole("button", { name: copy.nav.rail.update }));
    expect(await screen.findByText("This computer has no update credential.")).toBeInTheDocument();
  });

  it("shows no button on a preload without the update calls", () => {
    withBridge({});
    expect(screen.queryByRole("button", { name: copy.nav.rail.update })).toBeNull();
  });
});
