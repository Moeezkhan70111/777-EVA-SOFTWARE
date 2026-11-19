import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { PendingOrdersPage } from "./PendingOrdersPage";

// Pending Orders: one row per party with its pending cartons, opened for its products; filtered and searched by the
// main process. The figures are the data layer's (customerOrders.test.ts); this proves the screen shows them as sent,
// says progress in words, and asks again with the filter and search the operator chose.

const PARTY = { partyId: "party-1", partyName: "BEHRAAM SHOES", ordered: 45, dispatched: 27, pending: 18, lineCount: 4, orderCount: 2, progress: "PARTIAL" };
const LINES = [
  { productVariantId: "v1", article: "SK6", color: "BLUE", size: "6", ordered: 15, dispatched: 5, pending: 10, progress: "PARTIAL", orderCodes: ["ORD-000001"] },
  { productVariantId: "v2", article: "SK6", color: "BLACK", size: "7", ordered: 8, dispatched: 0, pending: 8, progress: "PENDING", orderCodes: ["ORD-000001", "ORD-000002"] },
  { productVariantId: "v3", article: "SK9", color: "RED", size: "7/10", ordered: 4, dispatched: 4, pending: 0, progress: "DISPATCHED", orderCodes: ["ORD-000002"] },
];

function createFakeBackend(rows: unknown[] = [PARTY]) {
  const api = {
    listPendingOrderParties: vi.fn(async () => ({ accepted: true, page: { rows, total: rows.length, page: 1, pageSize: 25, totalPending: rows.length ? 18 : 0 } })),
    listPendingOrderLines: vi.fn(async () => ({ accepted: true, lines: LINES })),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

const renderPage = (onEnterOrders?: () => void) => render(<NotificationsProvider><PendingOrdersPage token="token-1" onEnterOrders={onEnterOrders} /></NotificationsProvider>);

describe("Pending Orders", () => {
  it("shows each party's pending cartons, and when opened one matrix per article, sizes down and colours across", async () => {
    const api = createFakeBackend();
    renderPage();
    const row = await screen.findByRole("button", { name: "Show BEHRAAM SHOES's products" });
    expect(within(row).getByText("18")).toBeTruthy();
    expect(within(row).getByText("27 of 45 dispatched")).toBeTruthy();
    expect(within(row).getByText("cartons pending")).toBeTruthy();
    expect(screen.getByText("18 cartons pending")).toBeTruthy();

    await act(async () => { fireEvent.click(row); });
    const sk6 = await screen.findByRole("region", { name: "SK6" });
    expect(within(sk6).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Size", "BLACK", "BLUE"]);
    expect(within(sk6).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["6", "7", "Total"]);
    const blue6 = within(sk6).getByLabelText("SK6 BLUE 6: 10 pending of 15 ordered, 5 dispatched");
    expect(blue6.textContent).toBe("10");
    expect(blue6).toHaveAttribute("title", "Ord 15 · Sent 5");
    expect(within(sk6).getByLabelText("BLUE 7 not ordered").textContent).toBe("");
    expect(within(sk6).getByText("ORD-000001, ORD-000002")).toBeTruthy();
    const sk9 = screen.getByRole("region", { name: "SK9" });
    expect(within(sk9).getByLabelText("SK9 RED 7/10: 0 pending of 4 ordered, 4 dispatched").textContent).toContain("✓");
    expect(api.listPendingOrderLines).toHaveBeenCalledWith("party-1", { search: "", filter: "OUTSTANDING" }, { token: "token-1" });
  });

  it("asks again with the filter chosen", async () => {
    const api = createFakeBackend();
    renderPage();
    await screen.findByRole("button", { name: "Show BEHRAAM SHOES's products" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fully dispatched" })); });
    await waitFor(() => expect(api.listPendingOrderParties).toHaveBeenLastCalledWith({ search: "", filter: "DISPATCHED", page: 1, pageSize: 25 }, { token: "token-1" }));
  });

  it("says when nothing is pending, and offers to enter an order", async () => {
    createFakeBackend([]);
    const enter = vi.fn();
    renderPage(enter);
    expect(await screen.findByText("No pending orders")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Enter an order" })); });
    expect(enter).toHaveBeenCalled();
  });

  it("shows a load failure with Retry", async () => {
    const api = createFakeBackend();
    api.listPendingOrderParties.mockResolvedValueOnce({ accepted: false, reason: "Pending orders could not be loaded." } as never);
    renderPage();
    expect(await screen.findByText("Pending orders could not be loaded.")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /retry/i })); });
    expect(await screen.findByRole("button", { name: "Show BEHRAAM SHOES's products" })).toBeTruthy();
  });
});
