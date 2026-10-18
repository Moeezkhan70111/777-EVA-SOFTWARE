import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import type { NumberBlockStatus } from "../types/desktopApi";

// What Settings offers an operator, and what it must not.
//
// `sync.settings` was seeded as the literal string "disabled-phase-2" and rendered here as an
// ordinary text box labelled "Sync Settings". Nothing in the application reads that row, so an
// operator could type "enabled" into it, press Save, and change nothing whatsoever. Cloud sync
// is decided by this computer's environment variables and an administrator asking for a pass.
//
// These prove the field is gone from the editable grid and does not come back through the
// stored value — an existing database still HAS the row, and showing it is the bug.

const STORED_SETTINGS: Record<string, string> = {
  "factory.name": "777 Manufacturing",
  "factory.id": "factory-777",
  "workstation.name": "Production Line 01",
  "device.name": "Production Line 01",
  language: "en",
  theme: "light",
  "backup.folder": "C:\\backups",
  "backup.auto.enabled": "true",
  "backup.auto.time": "02:00",
  "logging.level": "INFO",
  "sound.enabled": "true",
  // Present in every database seeded before this field was removed.
  "sync.settings": "disabled-phase-2",
};

const UNCONFIGURED_BLOCK: NumberBlockStatus = {
  block: null,
  range: null,
  confirmed: false,
  problem: "NOT_CONFIGURED",
  storedValue: null,
  adoption: { allowed: false, refusal: "NO_EXISTING_DATA", detail: "This is a new installation." },
};

const api = {
  getSettings: vi.fn<() => Promise<Record<string, string>>>(),
  // CloudSyncSection, rendered by this page, reads these on mount.
  getCloudSyncStatus: vi.fn(),
  listDeadLetterEvents: vi.fn(),
  requeueDeadLetterEvent: vi.fn(),
  runCloudSync: vi.fn(),
  saveSettings: vi.fn<(settings: Record<string, string>) => Promise<void>>(),
  createBackup: vi.fn<() => Promise<{ backupPath: string }>>(),
  resetDatabase: vi.fn<() => Promise<void>>(),
  getNumberBlockStatus: vi.fn<() => Promise<NumberBlockStatus>>(),
  adoptNumberBlock: vi.fn(),
};

beforeEach(() => {
  api.getSettings.mockReset().mockResolvedValue({ ...STORED_SETTINGS });
  api.saveSettings.mockReset().mockResolvedValue(undefined);
  api.createBackup.mockReset().mockResolvedValue({ backupPath: "C:\\backups\\b.sqlite" });
  api.resetDatabase.mockReset().mockResolvedValue(undefined);
  api.getNumberBlockStatus.mockReset().mockResolvedValue(UNCONFIGURED_BLOCK);
  api.getCloudSyncStatus.mockReset().mockResolvedValue({
    configured: false,
    problems: ["ERP_SUPABASE_URL is not set"],
    running: false,
    queue: {
      counts: { PENDING: 0, IN_FLIGHT: 0, FAILED: 0, DEAD_LETTER: 0, SYNCED: 0 },
      pushableNow: 0,
      pushableWaiting: 0,
      notPushable: 0,
      lastSyncedAt: null,
      lastFailureAt: null,
    },
    pullCursor: 0,
  });
  api.listDeadLetterEvents.mockReset().mockResolvedValue({ accepted: true, entries: [] });
  api.requeueDeadLetterEvent.mockReset();
  api.runCloudSync.mockReset();
  api.adoptNumberBlock.mockReset();
  (window as unknown as { desktop: { api: typeof api } }).desktop = { api };
});

const show = (isAdmin = true) =>
  render(
    <NotificationsProvider>
      <SettingsPage isAdmin={isAdmin} />
    </NotificationsProvider>
  );

describe("the Settings page", () => {
  it("offers no Sync Settings control, even though the database still holds the row", async () => {
    const view = show();
    await screen.findByLabelText("Logging Level");

    expect(screen.queryByLabelText("Sync Settings")).toBeNull();
    expect(screen.queryByText("Sync Settings")).toBeNull();
    expect(view.container.querySelector("#setting-sync\\.settings")).toBeNull();

    // The stored placeholder must not reach the screen through any other control either.
    expect(screen.queryByDisplayValue("disabled-phase-2")).toBeNull();
    expect(view.container.textContent).not.toContain("disabled-phase-2");
  });

  it("still shows the other System settings and the unrelated groups", async () => {
    show();

    expect(await screen.findByLabelText("Logging Level")).toHaveValue("INFO");
    expect(screen.getByLabelText("Sound Enabled")).toHaveValue("true");
    expect(screen.getByLabelText("Factory Name")).toHaveValue("777 Manufacturing");
    expect(screen.getByLabelText("Auto Backup Time")).toHaveValue("02:00");
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("shows the cloud sync panel, and offers its actions only to an administrator", async () => {
    const asAdmin = show(true);
    expect(await screen.findByText("Cloud Sync")).toBeInTheDocument();
    // Not set up in this fixture, so no pass is offered even to an administrator.
    expect(screen.queryByRole("button", { name: "Sync Now" })).toBeNull();

    asAdmin.unmount();
    show(false);
    expect(await screen.findByText("Cloud Sync")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync Now" })).toBeNull();
    expect(screen.queryByText("Parked Events")).toBeNull();
  });

  it("saves an edit without discarding the settings it no longer displays", async () => {
    const user = userEvent.setup();
    show();

    const logging = await screen.findByLabelText("Logging Level");
    await user.clear(logging);
    await user.type(logging, "DEBUG");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    const saved = api.saveSettings.mock.calls[0]?.[0] ?? {};
    expect(saved["logging.level"]).toBe("DEBUG");
    expect(saved["factory.name"]).toBe("777 Manufacturing");
    // Removing the field from the grid must not erase the operator's stored row: the page sends
    // back what it was given for everything it does not render.
    expect(saved["sync.settings"]).toBe("disabled-phase-2");
  });
});
