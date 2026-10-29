import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceiptsTab } from "./ReceiptsTab";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { RawMaterialReceivingSession } from "../../types/desktopApi";

// Deliveries received: every Raw Material Input session, filterable, with the one open on
// this terminal (if any) offered as "continue where you left off" — never a session open on
// a different terminal, since a receiving session belongs to one device.

const OPEN_SESSION: RawMaterialReceivingSession = {
  id: "s-open",
  code: "RMI-000002",
  sessionNumber: 2,
  partyId: "p-1",
  partyName: "Vots Chemicals",
  deviceId: "device-1",
  startedBy: "aslam",
  status: "OPEN",
  startedAt: "2026-09-30T01:00:00.000Z",
  closedAt: null,
};

const CLOSED_SESSION: RawMaterialReceivingSession = {
  id: "s-closed",
  code: "RMI-000001",
  sessionNumber: 1,
  partyId: "p-2",
  partyName: "Shehzad Rubber Topping",
  deviceId: "device-1",
  startedBy: "aslam",
  status: "CLOSED",
  startedAt: "2026-09-29T01:00:00.000Z",
  closedAt: "2026-09-29T02:00:00.000Z",
};

function installApi(overrides: Record<string, unknown> = {}) {
  const sessions = [OPEN_SESSION, CLOSED_SESSION];
  const api = {
    listParties: vi.fn(async () => ({ rows: [], total: 0 })),
    listPurchaseVouchers: vi.fn(async () => ({ rows: [], total: 0 })),
    getPurchaseVoucher: vi.fn(async () => null),
    listRawMaterialReceivingSessions: vi.fn(async (filters?: { status?: "OPEN" | "CLOSED" }) =>
      filters?.status ? sessions.filter((session) => session.status === filters.status) : sessions
    ),
    getOpenRawMaterialReceivingSession: vi.fn(async () => null as RawMaterialReceivingSession | null),
    getRawMaterialReceivingSessionSummary: vi.fn(async () => null),
    ...overrides,
  };
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
  return api;
}

const renderTab = (onNavigate = vi.fn()) =>
  render(
    <NotificationsProvider>
      <ReceiptsTab username="moeezkhan123" onNavigate={onNavigate} />
    </NotificationsProvider>
  );

describe("ReceiptsTab — Deliveries received", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists every session, open and closed", async () => {
    installApi();
    renderTab();

    await waitFor(() => expect(screen.getByText("RMI-000002")).toBeInTheDocument());
    expect(screen.getByText("RMI-000001")).toBeInTheDocument();
  });

  it("offers to continue the session open on this terminal", async () => {
    installApi({ getOpenRawMaterialReceivingSession: vi.fn(async () => OPEN_SESSION) });
    const onNavigate = vi.fn();
    renderTab(onNavigate);

    await waitFor(() => expect(screen.getByText("A batch is open on this computer")).toBeInTheDocument());
    expect(screen.getAllByText(/RMI-000002/).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "Continue batch" }));
    expect(onNavigate).toHaveBeenCalledWith("raw-material-input");

    // The same session's row in the table offers its own Continue action too.
    const row = (await screen.findByText("RMI-000002")).closest("tr")!;
    expect(within(row).getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("marks a session open on another terminal instead of offering to continue it", async () => {
    installApi(); // getOpenRawMaterialReceivingSession resolves null: nothing open here
    renderTab();

    const row = (await screen.findByText("RMI-000002")).closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(row).toHaveTextContent("another terminal");
    expect(screen.queryByText("A batch is open on this computer")).not.toBeInTheDocument();
  });

  it("narrows the list to open sessions only", async () => {
    const api = installApi();
    renderTab();

    await waitFor(() => expect(screen.getByText("RMI-000001")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(screen.queryByText("RMI-000001")).not.toBeInTheDocument());
    expect(screen.getByText("RMI-000002")).toBeInTheDocument();
    expect(api.listRawMaterialReceivingSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "OPEN" })
    );
  });
});
