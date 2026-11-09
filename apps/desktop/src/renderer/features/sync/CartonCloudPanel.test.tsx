// The Carton Cloud panel as an administrator meets it: off and why, what stops activation, and an activation that
// asks first and names the project. Asserted in words (R18).

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CartonCloudPanel } from "./CartonCloudPanel";
import type { CartonCloudStatus } from "../../types/desktopApi";

const PROJECT = "https://prod.supabase.co";
const OFF: CartonCloudStatus = {
  state: "NOT_ACTIVATED", invalidReason: null, activation: null, problems: [], projectKey: PROJECT,
  leases: [
    { domain: "CARTON_STOCK", holderLabel: "PC 2", heldHere: true },
    { domain: "SALES_DISPATCH", holderLabel: "PC 2", heldHere: true },
    { domain: "ACCOUNTS", holderLabel: "PC 2", heldHere: true },
  ],
  localOnlyMarks: 7, parkedLocalStock: 0,
};
const ON: CartonCloudStatus = {
  ...OFF, state: "ACTIVE", problems: ["Carton Cloud is already active on this computer."],
  activation: { version: 1, activatedAt: "2026-11-10T04:00:00.000Z", activatedBy: "owner", deviceId: "dev-pc2", projectKey: PROJECT, cutoff: {} },
};

const withApi = (status: CartonCloudStatus | Error, activateCartonCloud = vi.fn().mockResolvedValue({ accepted: true, value: ON })) => {
  const getCartonCloudStatus = status instanceof Error ? vi.fn().mockRejectedValue(status) : vi.fn().mockResolvedValue({ accepted: true, value: status });
  (window as unknown as { desktop: unknown }).desktop = { api: { getCartonCloudStatus, activateCartonCloud } };
  render(<CartonCloudPanel />);
  return { getCartonCloudStatus, activateCartonCloud };
};

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
  vi.restoreAllMocks();
});

describe("Carton Cloud activation", () => {
  it("says it is off and that local carton work is never sent; activates only after asking, for the project shown", async () => {
    const { activateCartonCloud } = withApi(OFF);
    expect(await screen.findByText(/Off\. Carton stock, gatepasses, bills and cash vouchers .* never sent \(7 waiting here\)/)).toBeTruthy();
    expect(screen.getByText("CARTON_STOCK: PC 2 (this computer)")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Activate Carton Cloud" }));
    expect(activateCartonCloud).not.toHaveBeenCalled();
    expect(screen.getByText(PROJECT)).toBeTruthy();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Activate Carton Cloud" });
    await userEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(activateCartonCloud).toHaveBeenCalledWith(PROJECT));
    expect(await screen.findByText(/On since .* \(activated by owner\)/)).toBeTruthy();
  });

  it("lists what stops activation, and will not activate", async () => {
    withApi({ ...OFF, problems: ["Nobody holds the ACCOUNTS lease yet. Assign it to the computer that does that work, then sync."] });
    expect(await screen.findByText(/Nobody holds the ACCOUNTS lease yet/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Activate Carton Cloud" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says plainly when the activation here is not valid, and offers no button", async () => {
    withApi({ ...OFF, state: "INVALID", invalidReason: "the activation was made for another computer" });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/NOT on: the activation was made for another computer/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Activate Carton Cloud" })).toBeNull();
  });

  it("shows a failure to read with a retry", async () => {
    const { getCartonCloudStatus } = withApi(new Error("no answer"));
    expect(await screen.findByText("no answer")).toBeTruthy();
    getCartonCloudStatus.mockResolvedValue({ accepted: true, value: ON });
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/On since/)).toBeTruthy();
  });
});
