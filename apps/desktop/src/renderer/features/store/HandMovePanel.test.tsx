import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandMovePanel } from "./HandMovePanel";
import { NotificationsProvider } from "../../state/NotificationsContext";

// Move Out by Hand: "What for" is required moving OUT (0.3.6) and stays optional moving IN.
// The data layer refuses a move out without it too; this proves the form says so before sending.

const ITEM = { id: "item-nawaar", item_code: "RM-0001", display_name: "NAWAAR — 5 SOOTAR — BLACK" };

const SUPPLIER = { id: "party-1", partyCode: "PTY000001", partyName: "SHEHZAD RUBBER TOPPING", partyType: "SUPPLIER", status: "ACTIVE" };

const OPTIONS = {
  itemId: ITEM.id,
  itemCode: ITEM.item_code,
  displayName: ITEM.display_name,
  stockUnitCode: "INCH",
  stockUnitId: "unit-inch",
  quantityOnHand: 1950,
  units: ["INCH"],
  steps: [],
  labelledPacketsInStore: 0,
  blockedReason: null,
};

function createFakeBackend() {
  const moveRawMaterialByHand = vi.fn(async (_input: Record<string, unknown>, _opts?: { token?: string }) => ({
    accepted: true, outcome: "MOVED", direction: "OUT", quantity: 30, unitCode: "INCH", typedQuantity: 30, typedUnitCode: "INCH",
  }));
  const api = {
    listInventoryItems: vi.fn(async () => [ITEM]),
    listParties: vi.fn(async () => ({ rows: [SUPPLIER], total: 1, page: 1, pageSize: 1000 })),
    getRawMaterialHandMoveOptions: vi.fn(async () => OPTIONS),
    moveRawMaterialByHand,
  };
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
  return { moveRawMaterialByHand };
}

const renderPanel = (direction: "IN" | "OUT") =>
  render(
    <NotificationsProvider>
      <HandMovePanel direction={direction} token="token-1" />
    </NotificationsProvider>
  );

/** Picks the one material and types an amount, leaving "What for" to each test. */
const chooseMaterialAndAmount = async () => {
  const box = await screen.findByRole("combobox", { name: "Select Material" });
  await act(async () => {
    fireEvent.click(box);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole("option", { name: /NAWAAR/ }));
  });
  const amount = await screen.findByLabelText("How much");
  await act(async () => {
    fireEvent.change(amount, { target: { value: "30" } });
  });
};

describe("HandMovePanel — What for", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moving OUT marks What for as required, and will not move until it is filled", async () => {
    const { moveRawMaterialByHand } = createFakeBackend();
    renderPanel("OUT");
    await chooseMaterialAndAmount();

    const note = screen.getByLabelText(/What for/);
    expect(note).toBeRequired();
    expect(screen.getByText("*")).toBeInTheDocument();
    expect(screen.queryByText("(optional)")).toBeNull();

    const action = screen.getByRole("button", { name: "Move Out" });
    expect(action).toBeDisabled();
    expect(screen.getByText(/Say what this is going out for/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(note, { target: { value: "cutting table" } });
    });
    expect(action).toBeEnabled();
    await act(async () => {
      fireEvent.click(action);
    });
    await waitFor(() => expect(moveRawMaterialByHand).toHaveBeenCalledTimes(1));
    expect(moveRawMaterialByHand.mock.calls[0]?.[0]).toMatchObject({ direction: "OUT", note: "cutting table" });
  });

  it("only spaces do not count as saying what for", async () => {
    createFakeBackend();
    renderPanel("OUT");
    await chooseMaterialAndAmount();

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/What for/), { target: { value: "   " } });
    });
    expect(screen.getByRole("button", { name: "Move Out" })).toBeDisabled();
  });

  it("Manual Entry shows each supplier's type in the list, while choosing", async () => {
    createFakeBackend();
    renderPanel("IN");
    const box = await screen.findByRole("combobox", { name: "Select Supplier" });
    await act(async () => {
      fireEvent.click(box);
    });
    expect(await screen.findByRole("option", { name: /SHEHZAD RUBBER TOPPING/ })).toHaveTextContent("Supplier");
  });

  it("moving IN keeps its Reference optional", async () => {
    createFakeBackend();
    renderPanel("IN");
    await screen.findByRole("combobox", { name: "Select Material" });
    await chooseMaterialAndAmount();

    expect(screen.getByLabelText(/Reference/)).not.toBeRequired();
    expect(screen.getByText("(optional)")).toBeInTheDocument();
  });
});
