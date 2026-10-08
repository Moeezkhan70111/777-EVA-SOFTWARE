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

function setupDesktop(getHealth: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api: { getHealth } },
    configurable: true,
  });
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
});
