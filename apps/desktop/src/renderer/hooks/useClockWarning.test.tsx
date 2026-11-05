import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { NotificationsProvider, useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";
import type { CloudSyncStatus } from "../types/desktopApi";
import { useClockWarning } from "./useClockWarning";

// PC2's clock ran 22 hours out in October, and nothing said so.

const getCloudSyncStatus = vi.fn<() => Promise<Partial<CloudSyncStatus>>>();
const api = { getCloudSyncStatus };

vi.mock("./useDesktopApi", () => ({ useDesktopApi: () => api }));

const MINUTE_MS = 60_000;
const BEHIND_22_HOURS = { clockSkew: { direction: "BEHIND", minutes: 1320 } } as const;

const Signed = ({ userId }: { userId: string | null }) => {
  useClockWarning(userId);
  const { notices } = useNotifications();
  return (
    <ul>
      {notices.map((notice) => (
        <li key={notice.id}>{`${notice.kind}: ${notice.title}: ${notice.message ?? ""}`}</li>
      ))}
    </ul>
  );
};

const inProvider = (userId: string | null) => (
  <NotificationsProvider>
    <Signed userId={userId} />
  </NotificationsProvider>
);

const warnings = () => screen.queryAllByText(new RegExp(copy.clock.wrongTitle));
/** Lets a pending status read land, and any time pass. */
const advance = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("the clock warning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getCloudSyncStatus.mockReset();
    getCloudSyncStatus.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says nothing with no reading: a computer offline is not warned", async () => {
    render(inProvider("u-1"));
    await advance(10 * MINUTE_MS);
    expect(warnings()).toHaveLength(0);
  });

  it("says how far and which way, as a warning", async () => {
    getCloudSyncStatus.mockResolvedValue(BEHIND_22_HOURS);
    render(inProvider("u-1"));
    await advance();
    expect(screen.getByText(/^warning: /)).toHaveTextContent("about 22 hours behind");
  });

  it("counts minutes when it is under two hours, and says ahead when it is ahead", async () => {
    getCloudSyncStatus.mockResolvedValue({ clockSkew: { direction: "AHEAD", minutes: 12 } });
    render(inProvider("u-1"));
    await advance();
    expect(screen.getByText(/^warning: /)).toHaveTextContent("about 12 minutes ahead");
  });

  it("speaks when the first sync pass brings a reading, after sign-in", async () => {
    render(inProvider("u-1"));
    await advance();
    expect(warnings()).toHaveLength(0);

    getCloudSyncStatus.mockResolvedValue(BEHIND_22_HOURS);
    await advance(MINUTE_MS);
    expect(warnings()).toHaveLength(1);
  });

  it("keeps looking when a look fails", async () => {
    getCloudSyncStatus.mockRejectedValueOnce(new Error("no session"));
    render(inProvider("u-1"));
    await advance();
    getCloudSyncStatus.mockResolvedValue(BEHIND_22_HOURS);
    await advance(MINUTE_MS);
    expect(warnings()).toHaveLength(1);
  });

  it("waits for a sign-in: nobody is there to read it before that", async () => {
    getCloudSyncStatus.mockResolvedValue(BEHIND_22_HOURS);
    render(inProvider(null));
    await advance(MINUTE_MS);
    expect(getCloudSyncStatus).not.toHaveBeenCalled();
    expect(warnings()).toHaveLength(0);
  });

  it("stops asking once it has spoken, and stays until dismissed", async () => {
    getCloudSyncStatus.mockResolvedValue(BEHIND_22_HOURS);
    render(inProvider("u-1"));
    await advance();
    const asked = getCloudSyncStatus.mock.calls.length;
    await advance(10 * MINUTE_MS);
    expect(getCloudSyncStatus).toHaveBeenCalledTimes(asked);
    expect(warnings()).toHaveLength(1);
  });

  it("does not raise it again for the same person, and does for the next one", async () => {
    getCloudSyncStatus.mockResolvedValue(BEHIND_22_HOURS);
    const { rerender } = render(inProvider("u-1"));
    await advance();
    rerender(inProvider("u-1"));
    await advance(MINUTE_MS);
    expect(warnings()).toHaveLength(1);
    rerender(inProvider("u-2"));
    await advance();
    expect(warnings()).toHaveLength(2);
  });

  it("is raised once even when React runs the effect twice", async () => {
    getCloudSyncStatus.mockResolvedValue(BEHIND_22_HOURS);
    render(<React.StrictMode>{inProvider("u-1")}</React.StrictMode>);
    await advance(MINUTE_MS);
    expect(warnings()).toHaveLength(1);
  });

  it("stops looking when the person signs out", async () => {
    const { rerender } = render(inProvider("u-1"));
    await advance();
    rerender(inProvider(null));
    const asked = getCloudSyncStatus.mock.calls.length;
    await advance(10 * MINUTE_MS);
    expect(getCloudSyncStatus).toHaveBeenCalledTimes(asked);
  });
});
