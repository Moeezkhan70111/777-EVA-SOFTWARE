// The backfill panel as an administrator meets it on the store computer: what will go, and a button
// that stays off while anything would send wrong stock. Asserted in words (R18).

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BackfillPanel } from "./BackfillPanel";
import type { BackfillPlan } from "../../types/desktopApi";

const PLAN: BackfillPlan = {
  masterEpoch: 2, storeEpoch: 3, masterRecords: { INVENTORY_ITEM: 900, PARTY: 3 }, stockMovements: 4100,
  labelRunsToQueue: 12, packetsToQueue: 300, unstampedQueued: 0, mismatches: [],
};

const withApi = (plan: BackfillPlan, runBackfill = vi.fn().mockResolvedValue({ accepted: true, plan })) => {
  const getBackfillPlan = vi.fn().mockResolvedValue({ accepted: true, value: { plan, lastAt: null } });
  (window as unknown as { desktop: unknown }).desktop = { api: { getBackfillPlan, runBackfill } };
  render(<BackfillPanel />);
  return { getBackfillPlan, runBackfill };
};

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
  vi.restoreAllMocks();
});

describe("sending the store's history", () => {
  it("says what will go, asks first, then sends", async () => {
    const { runBackfill } = withApi(PLAN);
    expect(await screen.findByText(/903 master records/)).toBeTruthy();
    expect(screen.getByText("4100 stock movements")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Send History" }));
    expect(runBackfill).not.toHaveBeenCalled();
    const buttons = await screen.findAllByRole("button", { name: "Send History" });
    await userEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(runBackfill).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Marked\. It goes over the next syncs/)).toBeTruthy();
  });

  it("lists stock that does not add up, and will not send", async () => {
    withApi({ ...PLAN, mismatches: [{ itemId: "i-1", displayName: "Dana Black", balance: 7, fromMovements: 5, unitDiffers: true }] });
    expect(await screen.findByText("Dana Black")).toBeTruthy();
    expect(screen.getByText(/nothing will be sent until it is decided/)).toBeTruthy();
    expect(screen.getByText("⚠ Recorded in another unit")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send History" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so on a computer without both leases, and will not send", async () => {
    withApi({ ...PLAN, storeEpoch: null });
    expect(await screen.findByText(/Only the store computer can/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send History" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
