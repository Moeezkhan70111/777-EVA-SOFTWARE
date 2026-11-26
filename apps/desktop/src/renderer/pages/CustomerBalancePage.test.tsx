import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CustomerBalancePage } from "./CustomerBalancePage";

// Customer Balance (26 Nov 2026): the total in the hero, each customer a row that opens their ledger, a group filter
// that works, and all four states (R12).

const ROWS = [
  { partyId: "p1", partyName: "ABDUL GHANI HYDERABAD", city: "Hyderabad", groupName: "Hyderabad", balance: 50_000, lastVoucherDate: "2026-11-20", totalSales: 80_000, totalReceipts: 30_000, totalPayments: 0 },
  { partyId: "p2", partyName: "Behraam Shoes", city: "Karachi", groupName: null, balance: -2_000, lastVoucherDate: null, totalSales: 0, totalReceipts: 2_000, totalPayments: 0 },
];

function fakeApi(listCustomerBalances: () => Promise<unknown>) {
  const api = {
    listCustomerBalances: vi.fn(listCustomerBalances),
    listPartyGroups: vi.fn(async () => [{ id: "g1", groupName: "Hyderabad", isActive: true }]),
    onDataChanged: () => () => undefined,
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

const show = async (onOpenLedger = vi.fn()) => {
  await act(async () => { render(<CustomerBalancePage onNavigate={() => undefined} onOpenLedger={onOpenLedger} />); });
  return onOpenLedger;
};

describe("Customer Balance", () => {
  it("shows the total in the hero and opens a customer's ledger from their row", async () => {
    fakeApi(async () => ({ rows: ROWS, total: 2 }));
    const onOpen = await show();
    const hero = screen.getByRole("region", { name: "Total receivable" });
    expect(hero).toHaveTextContent("Rs. 48,000");
    expect(hero).toHaveTextContent("Receivable");
    expect(hero).toHaveTextContent("2 customers");
    const table = screen.getByRole("table", { name: "Customer balances" });
    expect(within(table).getByText("Advance")).toBeTruthy();
    fireEvent.click(within(table).getByRole("button", { name: "Open ABDUL GHANI HYDERABAD's ledger" }));
    expect(onOpen).toHaveBeenCalledWith("p1");
  });

  it("says so when no customer matches the search", async () => {
    fakeApi(async () => ({ rows: ROWS, total: 2 }));
    await show();
    fireEvent.change(screen.getByRole("searchbox", { name: /Search customers/ }), { target: { value: "nobody here" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByText("No customer matches")).toBeTruthy();
  });

  it("says when the balances could not be read, and reads them again on Retry", async () => {
    const api = fakeApi(async () => { throw new Error("db closed"); });
    await show();
    expect(screen.getByRole("alert")).toHaveTextContent("The balances could not be read.");
    api.listCustomerBalances.mockImplementation(async () => ({ rows: ROWS, total: 2 }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /retry/i })); });
    expect(screen.getByRole("table", { name: "Customer balances" })).toBeTruthy();
  });

  it("explains an empty book", async () => {
    fakeApi(async () => ({ rows: [], total: 0 }));
    await show();
    expect(screen.getByText("No customers yet")).toBeTruthy();
  });
});
