import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HealthPage } from "./HealthPage";

const baseHealth = {
  sqliteStatus: "OK",
  databaseSizeBytes: 1_000_000,
  pendingSyncQueue: 0,
  failedSyncQueue: 0,
  scannerConnected: true,
  diskFreeBytes: 5_000_000_000,
  memoryUsageBytes: 50_000_000,
  cpuLoadAverage: 0.5,
  backupStatus: "OK",
  appVersion: "1.0.0",
  deviceId: "test-device",
};

const baseQueue = {
  counts: { PENDING: 0, IN_FLIGHT: 0, FAILED: 0, DEAD_LETTER: 0, SYNCED: 0 },
  pushableNow: 0,
  pushableWaiting: 0,
  notPushable: 0,
  lastSyncedAt: null,
  lastFailureAt: null,
};

const baseCloudStatus = {
  configured: false,
  problems: ["ERP_SUPABASE_URL is not set"],
  running: false,
  queue: baseQueue,
  pullCursor: 0,
};

/** The value shown beside one label. HealthItem prefixes a bullet, so the text node is split. */
function itemValue(label: string): string {
  const labelNode = screen.getByText(label);
  const value = labelNode.parentElement?.querySelector(".health-item-value");
  return (value?.textContent ?? "").replace("●", "").trim();
}

function setupDesktop(getHealth: ReturnType<typeof vi.fn>, cloud: unknown = baseCloudStatus) {
  const getCloudSyncStatus = vi.fn().mockResolvedValue(cloud);
  Object.defineProperty(window, "desktop", {
    value: {
      versions: { node: "22", chrome: "128", electron: "43" },
      api: { getHealth, getCloudSyncStatus },
    },
    configurable: true,
  });
  return getCloudSyncStatus;
}

describe("HealthPage", () => {
  it("shows a passed status and no violation table when money integrity is healthy", async () => {
    const getHealth = vi.fn().mockResolvedValue({
      ...baseHealth,
      moneyDrift: { healthy: true, pairsChecked: 2, violationCount: 0, violations: [] },
    });
    setupDesktop(getHealth);

    render(<HealthPage />);

    expect(await screen.findByText(/Money integrity check passed/)).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows an issue-detected status and the violating row when money drift is found", async () => {
    const getHealth = vi.fn().mockResolvedValue({
      ...baseHealth,
      moneyDrift: {
        healthy: false,
        pairsChecked: 2,
        violationCount: 1,
        violations: [{ table: "report_daily_summary", column: "inventory_value_cost", id: "2026-01-01:factory-1", realValue: 500, paisaValue: 999999, expectedPaisa: 50000 }],
      },
    });
    setupDesktop(getHealth);

    render(<HealthPage />);

    expect(await screen.findByText(/Money integrity issue detected/)).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("report_daily_summary")).toBeInTheDocument();
    expect(screen.getByText("inventory_value_cost")).toBeInTheDocument();
    expect(screen.getByText("2026-01-01:factory-1")).toBeInTheDocument();
  });

  // The Sync Queue section has always shown two numbers that lump every aggregate type
  // together. These cover the Cloud Sync section beside it, which says what would actually go.

  it("shows what is ready to send, what has no transport, and what is parked", async () => {
    const getHealth = vi.fn().mockResolvedValue({
      ...baseHealth,
      moneyDrift: { healthy: true, pairsChecked: 2, violationCount: 0, violations: [] },
    });
    setupDesktop(getHealth, {
      configured: true,
      host: "zzdisposable.supabase.co",
      running: false,
      pullCursor: 12,
      queue: {
        counts: { PENDING: 3, IN_FLIGHT: 0, FAILED: 1, DEAD_LETTER: 2, SYNCED: 9 },
        pushableNow: 1,
        pushableWaiting: 1,
        notPushable: 2,
        lastSyncedAt: "2026-10-01T10:00:00.000Z",
        lastFailureAt: null,
      },
    });

    render(<HealthPage />);

    expect(await screen.findByText("Ready To Send")).toBeInTheDocument();
    expect(screen.getByText("No Transport Yet")).toBeInTheDocument();
    expect(screen.getByText("Parked (Dead Letter)")).toBeInTheDocument();
    expect(screen.getByText("Cloud Log Read To")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText(/Set up \(zzdisposable\.supabase\.co\)/)).toBeInTheDocument();
    expect(itemValue("Ready To Send")).toBe("1");
    expect(itemValue("No Transport Yet")).toBe("2");
    expect(itemValue("Parked (Dead Letter)")).toBe("2");
    expect(itemValue("Cloud Log Read To")).toBe("12");
    // A failure that never happened is said plainly, not dressed up as a time.
    expect(itemValue("Last Failure")).toBe("Never");
    expect(itemValue("Last Sent")).not.toBe("Never");
  });

  it("says a computer is not set up for cloud sync, and still shows its queue", async () => {
    const getHealth = vi.fn().mockResolvedValue({
      ...baseHealth,
      moneyDrift: { healthy: true, pairsChecked: 2, violationCount: 0, violations: [] },
    });
    setupDesktop(getHealth);

    render(<HealthPage />);

    expect(await screen.findByText("Not set up on this computer")).toBeInTheDocument();
    // Nothing has ever been sent from here, and the page says exactly that.
    expect(itemValue("Last Sent")).toBe("Never");
    expect(itemValue("Last Failure")).toBe("Never");
    expect(itemValue("Ready To Send")).toBe("0");
  });

  it("still renders the rest of the page when the cloud status cannot be read", async () => {
    const getHealth = vi.fn().mockResolvedValue({
      ...baseHealth,
      moneyDrift: { healthy: true, pairsChecked: 2, violationCount: 0, violations: [] },
    });
    const getCloudSyncStatus = setupDesktop(getHealth);
    getCloudSyncStatus.mockRejectedValue(new Error("Your session has expired."));

    render(<HealthPage />);

    expect(await screen.findByText(/Money integrity check passed/)).toBeInTheDocument();
    expect(screen.getByText("Pending Sync")).toBeInTheDocument();
    expect(screen.queryByText("Ready To Send")).toBeNull();
  });
});
