import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaleVoucherFormPage } from "./SaleVoucherFormPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import { NotificationCenter } from "../components/layout/NotificationCenter";
import type { SaleVoucher } from "../types/desktopApi";

// Saved bills: opening one by id, walking them with ‹ › and "Go to #", updating and deleting.
// Drafting a bill from a gatepass is covered in SaleVoucherFormPage.gatepass.test.tsx.

const party = { id: "p-1", partyCode: "P-0001", partyName: "ABC Traders", partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE", createdAt: "2024-01-01", balanceLimit: null };

const voucher = (id: string, voucherNumber: string): SaleVoucher => ({
  id, voucherNumber, partyId: "p-1", partyName: "ABC Traders",
  voucherDate: "2026-09-19", bookNo: "B1", subPartyName: null, subPartyNumber: null, remarks: null,
  totalQuantity: 1, totalAmount: 1800, status: "DRAFT",
  lineItems: [{ id: `li-${id}`, productVariantId: "prod-1", quantity: 1, priceType: "NORMAL" as const, unitPrice: 150, discount: 0, discountPerPair: 0, discountSource: "NONE" as const, totalPrice: 1800, article: "SK30", color: "Blue", size: "M" }],
  createdAt: "2026-09-19", updatedAt: "2026-09-19",
});

const listRow = (id: string, voucherNumber: string) => ({ id, voucherNumber, partyName: "ABC Traders", voucherDate: "2026-09-19", bookNo: "B1", subPartyName: null, totalQuantity: 1, totalAmount: 1800, status: "DRAFT", createdAt: "2026-09-19" });

function setupDesktop(overrides: Record<string, unknown> = {}) {
  const api = {
    listSaleVouchers: vi.fn(async (query: { search?: string }) => {
      const rows = [listRow("v-1", "7"), listRow("v-2", "8")].filter((row) => !query.search || row.voucherNumber === query.search);
      return { rows, total: rows.length, page: 1, pageSize: 1000 };
    }),
    getSaleVoucher: vi.fn(async (id: string) => (id === "v-1" ? voucher("v-1", "7") : id === "v-2" ? voucher("v-2", "8") : null)),
    getParty: vi.fn(async () => party),
    getCurrentPartyBalance: vi.fn(async () => 12000),
    resolveProductDiscountWithPrice: vi.fn(async () => ({ discountPerPair: 0, source: "NONE" })),
    updateSaleVoucher: vi.fn(async () => ({ accepted: true })),
    updateVoucherLineItem: vi.fn(async () => ({ accepted: true })),
    deleteSaleVoucher: vi.fn(async () => ({ accepted: true, cancelled: true, reversedEventCount: 0, ambiguousDispatchEventIds: [] })),
    ...overrides,
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

const renderPage = (props: { voucherId?: string } = {}) =>
  render(
    <NotificationsProvider>
      <SaleVoucherFormPage {...props} onNavigate={() => undefined} />
      <NotificationCenter />
    </NotificationsProvider>
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SaleVoucherFormPage", () => {
  it("opens a saved bill by id: number, party, one line per article + size (no colour), and the date fixed", async () => {
    setupDesktop();
    renderPage({ voucherId: "v-1" });

    await waitFor(() => expect(screen.getByTestId("voucher-number")).toHaveTextContent("7"));
    expect(screen.getByTestId("party-card")).toHaveTextContent("ABC Traders");
    await waitFor(() => expect(screen.getByTestId("party-balance")).toHaveTextContent("Rs 12,000"));
    const rows = screen.getAllByTestId("bill-line");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("SK30")).toBeInTheDocument();
    expect(within(rows[0]).queryByText("Blue")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Date")).toBeDisabled();
    expect(screen.getByTestId("print-voucher")).toBeEnabled();
    expect(screen.getByTestId("bill-totals")).toHaveTextContent("Rs 1,800.00");
  });

  it("walks the saved bills with ‹ ›, past the last one shows the gatepass picker, and Go to # jumps", async () => {
    const api = setupDesktop();
    renderPage({ voucherId: "v-1" });
    await waitFor(() => expect(screen.getByTestId("voucher-number")).toHaveTextContent("7"));

    await userEvent.click(screen.getByTestId("voucher-next"));
    await waitFor(() => expect(screen.getByTestId("voucher-number")).toHaveTextContent("8"));

    await userEvent.click(screen.getByTestId("voucher-next"));
    await screen.findByTestId("bill-empty");
    expect(screen.getByTestId("voucher-number")).toHaveTextContent("9");
    expect(screen.getByTestId("bill-save")).toBeDisabled();

    await userEvent.click(screen.getByTestId("voucher-prev"));
    await waitFor(() => expect(screen.getByTestId("voucher-number")).toHaveTextContent("8"));

    fireEvent.change(screen.getByTestId("voucher-number-input"), { target: { value: "7" } });
    await userEvent.click(screen.getByTestId("voucher-go"));
    await waitFor(() => expect(api.getSaleVoucher).toHaveBeenLastCalledWith("v-1"));
    await waitFor(() => expect(screen.getByTestId("voucher-number")).toHaveTextContent("7"));
  });

  it("Update saves the header and every line through the backend, which is the authority on the discount", async () => {
    const api = setupDesktop();
    renderPage({ voucherId: "v-1" });
    await waitFor(() => expect(screen.getByTestId("voucher-number")).toHaveTextContent("7"));

    fireEvent.change(screen.getByLabelText("Book No"), { target: { value: "B2" } });
    fireEvent.change(screen.getByLabelText("Dzn SK30 M"), { target: { value: "2" } });
    await userEvent.click(screen.getByRole("button", { name: /Update Voucher/ }));

    await waitFor(() => expect(api.updateSaleVoucher).toHaveBeenCalledWith("v-1", { bookNo: "B2", subPartyNameUrdu: "", remarks: "" }));
    expect(api.updateVoucherLineItem).toHaveBeenCalledWith("li-v-1", { productVariantId: "prod-1", quantity: 2, unitPrice: 150, discount: 0, priceType: "NORMAL" });
    expect(await screen.findByText("Voucher #7 saved")).toBeInTheDocument();
  });

  // The data layer (packages/data) already reverses attributed dispatch events and reports
  // reversedEventCount/ambiguousDispatchEventIds; these tests only verify the renderer shows
  // the right toast for each case, not the underlying reversal logic.

  it("shows the existing success toast when a voucher deletes cleanly (no ambiguous events)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setupDesktop({ deleteSaleVoucher: vi.fn().mockResolvedValue({ accepted: true, cancelled: true, reversedEventCount: 2, ambiguousDispatchEventIds: [] }) });
    renderPage({ voucherId: "v-1" });

    const deleteButton = await screen.findByRole("button", { name: /delete voucher/i });
    await userEvent.click(deleteButton);

    expect(await screen.findByText("Voucher #7 deleted")).toBeInTheDocument();
    expect(screen.queryByText(/review needed/i)).not.toBeInTheDocument();
    // The deleted number stays on screen; the desk is back at the gatepass picker.
    expect(screen.getByTestId("voucher-number")).toHaveTextContent("7");
    expect(screen.getByTestId("bill-empty")).toBeInTheDocument();
  });

  it("warns instead of celebrating when the voucher deletes but legacy dispatch events are ambiguous", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setupDesktop({ deleteSaleVoucher: vi.fn().mockResolvedValue({ accepted: true, cancelled: true, reversedEventCount: 1, ambiguousDispatchEventIds: ["evt-1", "evt-2"] }) });
    renderPage({ voucherId: "v-1" });

    const deleteButton = await screen.findByRole("button", { name: /delete voucher/i });
    await userEvent.click(deleteButton);

    expect(await screen.findByText(/review needed/i)).toBeInTheDocument();
    const warningBody = screen.getByText(/could not be automatically matched/i);
    expect(warningBody.textContent).toMatch(/2 older dispatch scans/i);
    expect(warningBody.textContent).toMatch(/NOT reversed/);
    // This is a successful deletion with a follow-up warning, not a failure — the plain
    // "deleted" success toast is simply superseded by the more informative warning, and
    // nothing here should claim the ambiguous events themselves were reversed.
    expect(screen.queryByText("Voucher #7 deleted")).not.toBeInTheDocument();
  });
});
