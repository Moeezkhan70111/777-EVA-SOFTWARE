// The only part of automatic updates an operator ever sees.
//
// The promise being tested is mostly a promise of SILENCE: checking, downloading and failing all
// happen with nothing on screen, and exactly one state — a build downloaded and waiting — is
// allowed to interrupt somebody mid-shift.

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationsProvider } from "../state/NotificationsContext";
import { NotificationCenter } from "../components/layout/NotificationCenter";
import { useAppUpdate } from "./useAppUpdate";
import type { AppUpdateStatus } from "../types/desktopApi";

const Harness = () => {
  useAppUpdate();
  return <NotificationCenter />;
};

const renderWith = (status: unknown, installResult: { accepted: boolean; reason?: string } = { accepted: true }) => {
  const getUpdateStatus = vi.fn().mockResolvedValue(status);
  const installUpdate = vi.fn().mockResolvedValue(installResult);
  // The hook reaches the bridge through useDesktopApi, which is window.desktop.api.
  (window as unknown as { desktop: unknown }).desktop = { api: { getUpdateStatus, installUpdate } };
  render(
    <NotificationsProvider>
      <Harness />
    </NotificationsProvider>
  );
  return { getUpdateStatus, installUpdate };
};

const status = (overrides: Partial<AppUpdateStatus>): AppUpdateStatus => ({
  phase: "IDLE",
  currentVersion: "0.3.1",
  ...overrides,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
});

describe("what the operator is never shown", () => {
  it.each<AppUpdateStatus["phase"]>(["IDLE", "CHECKING", "UP_TO_DATE", "DISABLED", "ERROR"])(
    "says nothing at all while %s",
    async (phase) => {
      renderWith(status({ phase, reason: "something went wrong" }));
      // Given a tick for the first poll to land, there must still be no notice.
      await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
      expect(screen.queryByText(/update/i)).toBeNull();
    }
  );

  it("says nothing while a download is in progress — a percentage is not news", async () => {
    renderWith(status({ phase: "DOWNLOADING", percent: 61, availableVersion: "0.3.2" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("stays silent when the bridge answers with something malformed", async () => {
    renderWith({ nonsense: true });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});

describe("the one prompt it does show", () => {
  it("offers a restart once a version is downloaded, naming it", async () => {
    renderWith(status({ phase: "READY", availableVersion: "0.3.2" }));
    expect(await screen.findByText(/Update Ready/i)).toBeTruthy();
    expect(screen.getByText(/Version 0\.3\.2 has been downloaded/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Restart Now/i })).toBeTruthy();
  });

  it("tells the operator their work is safe, because that is the question they will have", async () => {
    renderWith(status({ phase: "READY", availableVersion: "0.3.2" }));
    expect(await screen.findByText(/your work is saved/i)).toBeTruthy();
  });

  it("installs when the operator asks", async () => {
    const { installUpdate } = renderWith(status({ phase: "READY", availableVersion: "0.3.2" }));
    await userEvent.click(await screen.findByRole("button", { name: /Restart Now/i }));
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  it("explains a refused install instead of leaving a dead button", async () => {
    renderWith(status({ phase: "READY", availableVersion: "0.3.2" }), {
      accepted: false,
      reason: "There is no downloaded update to install yet.",
    });
    await userEvent.click(await screen.findByRole("button", { name: /Restart Now/i }));
    expect(await screen.findByText(/could not be installed/i)).toBeTruthy();
    // The prompt goes: pressing it again would not help.
    await waitFor(() => expect(screen.queryByRole("button", { name: /Restart Now/i })).toBeNull());
  });

  it("shows ONE prompt however many times the poll reports the same thing", async () => {
    renderWith(status({ phase: "READY", availableVersion: "0.3.2" }));
    await screen.findByText(/Update Ready/i);
    // The notice is keyed, so repeated polls replace it rather than stacking copies that would
    // push every other notification off the screen.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Restart Now/i })).toHaveLength(1));
  });

  it("does not vanish while it is being read", async () => {
    renderWith(status({ phase: "READY", availableVersion: "0.3.2" }));
    // Rendered and awaited on real timers, so this cannot pass by never having appeared.
    expect(await screen.findByText(/Update Ready/i)).toBeTruthy();

    // Only now take over the clock. Ordinary notices expire after 3.8s; a notice that asks a
    // question must still be there long after that.
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(screen.queryByText(/Update Ready/i)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Restart Now/i })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
