import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StockCorrectionPanel } from "./StockCorrectionPanel";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { StockCorrectionRequest } from "../../types/desktopApi";

// Two people stand in front of this panel. A storekeeper sends a correction and waits; an
// administrator decides it. Neither is offered the other's action, and neither can get a
// correction through without saying why.

const PENDING: StockCorrectionRequest = {
  id: "req-1",
  requestCode: "SCR-000001",
  itemId: "item-1",
  itemDisplayName: "RUBBER UPPER — SK6 — RED — 7/10",
  itemCode: "RM-000001",
  quantity: -3,
  unitId: "u-1",
  unitCode: "DOZ",
  reason: "3 packets damaged in handling",
  status: "PENDING",
  requestedBy: "u-aslam",
  requestedByName: "aslam",
  requestedAt: "2026-09-28T09:00:00.000Z",
  reviewedBy: null,
  reviewedByName: null,
  reviewedAt: null,
  reviewNotes: null,
};

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    listStockCorrectionRequestsForItem: vi.fn(async () => [] as StockCorrectionRequest[]),
    createStockCorrectionRequest: vi.fn(async () => ({ accepted: true, request: PENDING })),
    reviewStockCorrectionRequest: vi.fn(async () => ({ accepted: true, request: { ...PENDING, status: "APPROVED" as const } })),
    adjustInventoryStock: vi.fn(async () => ({ accepted: true })),
    ...overrides,
  };
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
  return api;
}

const renderPanel = (isAdmin: boolean) =>
  render(
    <NotificationsProvider>
      <StockCorrectionPanel
        itemId="item-1"
        displayName="RUBBER UPPER — SK6 — RED — 7/10"
        unitCode="DOZ"
        isAdmin={isAdmin}
        ladder={null}
        onStockChanged={vi.fn(async () => {})}
      />
    </NotificationsProvider>
  );

describe("StockCorrectionPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends a storekeeper's correction for approval instead of applying it", async () => {
    const api = installApi();
    renderPanel(false);

    await userEvent.type(await screen.findByLabelText("Correct the count by"), "-3");
    await userEvent.type(screen.getByLabelText(/^Why/), "3 packets damaged in handling");
    await userEvent.click(screen.getByRole("button", { name: "Send for approval" }));

    await waitFor(() =>
      expect(api.createStockCorrectionRequest).toHaveBeenCalledWith({
        itemId: "item-1",
        quantity: -3,
        reason: "3 packets damaged in handling",
      })
    );
    expect(api.adjustInventoryStock).not.toHaveBeenCalled();
  });

  it("will not send a correction with no usable reason", async () => {
    const api = installApi();
    renderPanel(false);

    await userEvent.type(await screen.findByLabelText("Correct the count by"), "-3");
    await userEvent.type(screen.getByLabelText(/^Why/), "up");

    expect(screen.getByRole("button", { name: "Send for approval" })).toBeDisabled();
    expect(screen.getByText(/reason the administrator can judge/i)).toBeInTheDocument();
    expect(api.createStockCorrectionRequest).not.toHaveBeenCalled();
  });

  it("applies an administrator's own correction at once", async () => {
    const api = installApi();
    renderPanel(true);

    await userEvent.type(await screen.findByLabelText("Correct the count by"), "-4");
    await userEvent.type(screen.getByLabelText(/^Why/), "Counted short at stocktake");
    await userEvent.click(screen.getByRole("button", { name: "Apply correction" }));

    await waitFor(() =>
      expect(api.adjustInventoryStock).toHaveBeenCalledWith({
        itemId: "item-1",
        quantity: -4,
        note: "Counted short at stocktake",
      })
    );
    expect(api.createStockCorrectionRequest).not.toHaveBeenCalled();
  });

  it("shows a waiting correction to its sender, with no way to approve it", async () => {
    installApi({ listStockCorrectionRequestsForItem: vi.fn(async () => [PENDING]) });
    renderPanel(false);

    expect(await screen.findByText(/Waiting for approval/i)).toBeInTheDocument();
    expect(screen.getByText(/3 packets damaged in handling/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Correct the count by")).not.toBeInTheDocument();
  });

  it("lets an administrator approve a waiting correction, which applies it", async () => {
    const api = installApi({ listStockCorrectionRequestsForItem: vi.fn(async () => [PENDING]) });
    renderPanel(true);

    await userEvent.click(await screen.findByRole("button", { name: /Approve & apply/i }));

    await waitFor(() => expect(api.reviewStockCorrectionRequest).toHaveBeenCalledWith("req-1", "APPROVED", undefined));
  });

  it("asks an administrator to say why before declining", async () => {
    const api = installApi({ listStockCorrectionRequestsForItem: vi.fn(async () => [PENDING]) });
    renderPanel(true);

    await userEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await userEvent.type(screen.getByLabelText(/Tell aslam why/i), "Recount first");
    await userEvent.click(screen.getByRole("button", { name: "Decline correction" }));

    await waitFor(() => expect(api.reviewStockCorrectionRequest).toHaveBeenCalledWith("req-1", "REJECTED", "Recount first"));
  });
});
