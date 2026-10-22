// The rail indicator, as somebody who does not know what a sync is would meet it.
//
// The assertions are deliberately about WORDS, not classes: the promise is that a person can
// glance at the rail and know whether to worry, and a green pixel does not keep that promise on
// its own (R18 — never colour alone).

import React from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SyncStatusIndicator } from "./SyncStatusIndicator";
import type { CloudSyncStatus } from "../../types/desktopApi";

const QUEUE = (over: Partial<CloudSyncStatus["queue"]> = {}): CloudSyncStatus["queue"] => ({
  counts: { PENDING: 0, IN_FLIGHT: 0, FAILED: 0, DEAD_LETTER: 0, SYNCED: 0 },
  pushableNow: 0,
  pushableWaiting: 0,
  notPushable: 0,
  lastSyncedAt: null,
  lastFailureAt: null,
  ...over,
});

const STATUS = (over: Partial<CloudSyncStatus> = {}): CloudSyncStatus => ({
  configured: true,
  running: false,
  queue: QUEUE(),
  pullCursor: 0,
  lastAttempt: {
    id: "r1", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    trigger: "TIMER", outcome: "OK", pushed: 0, fetched: 0, applied: 0, duplicates: 0, refused: 0, reason: null,
  },
  lastSuccess: {
    id: "r1", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    trigger: "TIMER", outcome: "OK", pushed: 0, fetched: 0, applied: 0, duplicates: 0, refused: 0, reason: null,
  },
  ...over,
});

const renderWith = (status: unknown, runResult: { accepted: boolean; reason?: string } = { accepted: true }) => {
  const getCloudSyncStatus = vi.fn().mockResolvedValue(status);
  const runCloudSync = vi.fn().mockResolvedValue(runResult);
  (window as unknown as { desktop: unknown }).desktop = { api: { getCloudSyncStatus, runCloudSync } };
  const onOpenSettings = vi.fn();
  // No provider wrapper on purpose: this component must work in the navigation rail, which is
  // rendered in places that have neither a notifications provider nor a desktop bridge.
  render(<SyncStatusIndicator onOpenSettings={onOpenSettings} />);
  return { getCloudSyncStatus, runCloudSync, onOpenSettings };
};

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
  vi.restoreAllMocks();
});

describe("what the rail says at a glance", () => {
  it("says Up To Date when things are working", async () => {
    renderWith(STATUS());
    expect(await screen.findByText("Up To Date")).toBeTruthy();
  });

  it("says Waiting To Send when work is queued", async () => {
    renderWith(STATUS({ queue: QUEUE({ pushableNow: 4 }) }));
    expect(await screen.findByText("Waiting To Send")).toBeTruthy();
  });

  it("says Needs Attention when something is stuck", async () => {
    renderWith(STATUS({ queue: QUEUE({ counts: { ...QUEUE().counts, DEAD_LETTER: 3 } }) }));
    expect(await screen.findByText("Needs Attention")).toBeTruthy();
  });

  it("says Not Connected on a computer that does not sync", async () => {
    renderWith(STATUS({ configured: false }));
    expect(await screen.findByText("Not Connected")).toBeTruthy();
  });

  it("puts the whole answer in the accessible name, not only in a colour", async () => {
    renderWith(STATUS({ queue: QUEUE({ pushableNow: 2 }) }));
    // A screen reader, or a person who cannot distinguish the amber from the green, gets the
    // same answer as everyone else.
    const button = await screen.findByRole("button", { name: /Other Computers: Waiting To Send/i });
    expect(button).toBeTruthy();
  });

  it("stays quiet rather than alarming while the first read is still in flight", () => {
    renderWith(new Promise(() => undefined));
    // Nothing is known yet; the quietest state is the honest one.
    expect(screen.queryByText("Needs Attention")).toBeNull();
  });

  it("does not throw on a malformed answer from the bridge", async () => {
    renderWith({ nonsense: true });
    expect(await screen.findByText("Not Connected")).toBeTruthy();
  });
});

describe("the detail behind the dot", () => {
  it("explains the state in a sentence a non-technical person can act on", async () => {
    renderWith(STATUS({ queue: QUEUE({ pushableNow: 7 }) }));
    await userEvent.click(await screen.findByRole("button", { name: /Other Computers/i }));

    expect(await screen.findByText(/7 items are waiting to reach the other computers/i)).toBeTruthy();
    // The reassurance matters as much as the number: people stop working when they think
    // something is broken.
    expect(screen.getByText(/nothing is lost, and you can carry on working/i)).toBeTruthy();
  });

  it("shows when work was last shared, in words", async () => {
    renderWith(STATUS());
    await userEvent.click(await screen.findByRole("button", { name: /Other Computers/i }));
    expect(await screen.findByText("Last shared")).toBeTruthy();
    expect(screen.getByText("just now")).toBeTruthy();
  });

  it("says Never rather than inventing a time", async () => {
    renderWith(STATUS({ lastSuccess: null, lastAttempt: null }));
    await userEvent.click(await screen.findByRole("button", { name: /Other Computers/i }));
    expect(await screen.findByText("Never")).toBeTruthy();
  });

  it("names who has to act when something is stuck", async () => {
    renderWith(STATUS({ queue: QUEUE({ counts: { ...QUEUE().counts, DEAD_LETTER: 1 } }) }));
    await userEvent.click(await screen.findByRole("button", { name: /Other Computers/i }));
    expect(await screen.findByText(/Someone needs to look at it in Settings/i)).toBeTruthy();
  });

  it("explains a refused computer as a setup problem, not a network one", async () => {
    renderWith(
      STATUS({
        lastAttempt: {
          id: "r2", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          trigger: "TIMER", outcome: "REFUSED", pushed: null, fetched: null, applied: null,
          duplicates: null, refused: null, reason: "NOT_ENROLLED",
        },
      })
    );
    await userEvent.click(await screen.findByRole("button", { name: /Other Computers/i }));
    expect(await screen.findByText(/An administrator needs to check this computer's setup/i)).toBeTruthy();
  });

  it("offers Send Now, and the panel survives the click", async () => {
    const { runCloudSync } = renderWith(STATUS());
    await userEvent.click(await screen.findByRole("button", { name: /Other Computers/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Send Now/i }));

    // The panel is portalled out of the trigger's wrapper, so without the dismiss hook being
    // told about it, this click would have closed the panel instead of sending anything.
    expect(runCloudSync).toHaveBeenCalledTimes(1);
  });

  it("reports a refused send instead of failing silently", async () => {
    renderWith(STATUS(), { accepted: false, reason: "A cloud sync is already running on this computer." });
    await userEvent.click(await screen.findByRole("button", { name: /Other Computers/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Send Now/i }));
    expect(await screen.findByText(/already running on this computer/i)).toBeTruthy();
  });

  it("offers no actions on a computer that does not sync", async () => {
    renderWith(STATUS({ configured: false }));
    await userEvent.click(await screen.findByRole("button", { name: /Other Computers/i }));
    expect(await screen.findByText(/keeps working on its own/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Send Now/i })).toBeNull();
  });

  it("opens Settings, where the fixes live", async () => {
    const { onOpenSettings } = renderWith(STATUS());
    await userEvent.click(await screen.findByRole("button", { name: /Other Computers/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Open Settings/i }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
