// The warning on the working screens: shown while Carton Cloud is off on a syncing computer, never on one that does not
// sync or once it is active, and shown when the state cannot be read. Asserted in words (R18).

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CartonCloudOffNotice } from "./CartonCloudOffNotice";

const withState = (reply: Promise<unknown>) => {
  (window as unknown as { desktop: unknown }).desktop = { api: { getCartonCloudState: vi.fn().mockReturnValue(reply) } };
  return render(<CartonCloudOffNotice />);
};

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
  vi.restoreAllMocks();
});

describe("the Carton Cloud warning on the working screens", () => {
  it("warns on a syncing computer where Carton Cloud is not active yet", async () => {
    withState(Promise.resolve({ accepted: true, value: { configured: true, state: "NOT_ACTIVATED" } }));
    expect(await screen.findByText("Carton Cloud is not active on this computer")).toBeTruthy();
    expect(screen.getByText(/stays on this computer as test data/)).toBeTruthy();
  });

  it("says so when the activation is not valid", async () => {
    withState(Promise.resolve({ accepted: true, value: { configured: true, state: "INVALID" } }));
    expect(await screen.findByText(/activation on this computer is not valid/)).toBeTruthy();
  });

  it("warns when the state cannot be read", async () => {
    withState(Promise.reject(new Error("no answer")));
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
  });

  it("shows nothing once Carton Cloud is active, or on a computer that does not sync", async () => {
    const active = withState(Promise.resolve({ accepted: true, value: { configured: true, state: "ACTIVE" } }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    active.unmount();
    withState(Promise.resolve({ accepted: true, value: { configured: false, state: "NOT_ACTIVATED" } }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});
