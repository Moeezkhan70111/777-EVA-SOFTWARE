import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaleVoucherFormPage } from "./SaleVoucherFormPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import { NotificationCenter } from "../components/layout/NotificationCenter";
import type { Gatepass, SaleVoucher } from "../types/desktopApi";
import { copy } from "../config/copy";

// The billing desk clicks a gatepass notice (or types its number). The form must fill itself
// from the gatepass — party, date, one line per article + size in dozens (colours folded in)
// with the party's rate and discount — and write nothing until Save; then the bill is linked
// to the gatepass and stays on screen to print. A bill already made from the gatepass opens
// instead; a cancelled gatepass shows the delete banner. Retyping a rate re-resolves the less.

const PARTY = { id: "p-abc", partyCode: "P-0001", partyName: "ABC Traders", partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z" };
const PRODUCTS = [
  { id: "v-sk6-blue", article: "SK6", color: "BLUE", size: "7/10", description: null, costPrice: 400, sellingPrice: 550, mainGroupId: null, groupId: null, status: "ACTIVE", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  { id: "v-sk6-red", article: "SK6", color: "RED", size: "7/10", description: null, costPrice: 400, sellingPrice: 600, mainGroupId: null, groupId: null, status: "ACTIVE", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
];

const GATEPASS: Gatepass = {
  id: "gp-7", code: "GP-000007", gatepassNumber: 7, partyId: "p-abc", partyName: "ABC Traders", partyCode: "P-0001", partyCity: "Lahore",
  gatepassDate: "2026-09-18", status: "CREATED", biltyNumber: "B-4471", transportVia: "Daewoo Cargo", remarks: null, totalQuantity: 30, dispatchedFromStoreQuantity: 0, outstandingQuantity: 30, lineCount: 2,
  createdBy: "clerk", createdAt: "2026-09-18T10:00:00.000Z", updatedAt: "2026-09-18T10:00:00.000Z", cancelledAt: null, cancelledBy: null, cancelReason: null,
  lines: [
    { id: "l1", lineNo: 1, productVariantId: "v-sk6-blue", groupName: null, article: "SK6", color: "BLUE", size: "7/10", quantity: 20, storeQuantityAtCreation: 120, dispatchedFromStoreQuantity: 0, outstandingQuantity: 20 },
    { id: "l2", lineNo: 2, productVariantId: "v-sk6-red", groupName: null, article: "SK6", color: "RED", size: "7/10", quantity: 10, storeQuantityAtCreation: 85, dispatchedFromStoreQuantity: 0, outstandingQuantity: 10 },
  ],
};

const savedVoucher = (gatepass: Pick<Gatepass, "id" | "code" | "status"> | null): SaleVoucher => ({
  id: "sv-1", voucherNumber: "45", partyId: "p-abc", partyName: "ABC Traders", voucherDate: "2026-09-18", bookNo: "", subPartyName: null, subPartyNumber: null,
  remarks: "", totalQuantity: 15, totalAmount: 100200, status: "DRAFT",
  gatepassId: gatepass?.id ?? null, gatepassCode: gatepass?.code ?? null, gatepassStatus: gatepass?.status ?? null,
  lineItems: [
    // Saved on the party's Rs 10 article rule (10 dozen × 12 × 10 = 1200).
    { id: "li-1", productVariantId: "v-sk6-blue", quantity: 10, priceType: "NORMAL", unitPrice: 550, discount: 1200, discountPerPair: 10, discountSource: "ARTICLE", totalPrice: 64800, article: "SK6", color: "BLUE", size: "7/10" },
    // Saved before any rule existed for it.
    { id: "li-2", productVariantId: "v-sk6-red", quantity: 5, priceType: "NORMAL", unitPrice: 600, discount: 0, discountPerPair: 0, discountSource: "NONE", totalPrice: 36000, article: "SK6", color: "RED", size: "7/10" },
  ],
  createdAt: "2026-09-18T11:00:00.000Z", updatedAt: "2026-09-18T11:00:00.000Z",
});

function setupDesktop(overrides: Record<string, unknown> = {}) {
  const api = {
    listSaleVouchers: vi.fn(async () => ({ rows: [], total: 0, page: 1, pageSize: 1000 })),
    getParty: vi.fn(async () => ({ ...PARTY, balanceLimit: 250000 })),
    getCurrentPartyBalance: vi.fn(async () => 185000),
    // This computer holds Accounts, so balances show (features/parties/ledgerVisibility.ts).
    getHeldLeases: vi.fn(async () => ["ACCOUNTS"]),
    getSaleableVariant: vi.fn(async (id: string) => {
      const p = PRODUCTS.find((row) => row.id === id);
      return p ? { id, article: p.article, size: p.size, color: p.color, sellingPrice: p.sellingPrice, stockQuantity: 100, articleSeriesId: null, productGroupId: null } : null;
    }),
    // SK6 (any colour) gets the party's Rs 10 / pair article discount; at Rs 600+ a price-range rule of Rs 15 wins instead.
    resolveProductDiscountWithPrice: vi.fn(async (_partyId: string, variantId: string, price: number) =>
      price >= 600 ? { discountPerPair: 15, source: "PRICE_RANGE" } : variantId.startsWith("v-sk6") ? { discountPerPair: 10, source: "ARTICLE" } : { discountPerPair: 0, source: "NONE" }),
    findSaleVoucherByGatepass: vi.fn(async () => null),
    getGatepass: vi.fn(async () => GATEPASS),
    getGatepassByNumber: vi.fn(async (gatepassNumber: number) => (gatepassNumber === 7 ? GATEPASS : null)),
    createSaleVoucher: vi.fn(async (_input: Record<string, unknown>) => ({ accepted: true, id: "sv-1", voucherNumber: "45" })),
    addVoucherLineItem: vi.fn(async (_voucherId: string, _line: Record<string, unknown>) => ({ accepted: true, id: "li-x" })),
    getSaleVoucher: vi.fn(async () => savedVoucher(GATEPASS)),
    deleteSaleVoucher: vi.fn(async () => ({ accepted: true, cancelled: true, reversedEventCount: 0, ambiguousDispatchEventIds: [] })),
    ...overrides,
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

const renderPage = (props: { fromGatepassId?: string; voucherId?: string } = {}) =>
  render(
    <NotificationsProvider>
      <SaleVoucherFormPage {...props} token="token-bill" onNavigate={() => undefined} />
      <NotificationCenter />
    </NotificationsProvider>
  );

/**
 * The line rows of the items table as [article, dozens, rate, less/pair].
 *
 * Dozens are read from the CELL, not an input: on a bill made from a gatepass the quantity
 * is what went out, so it is shown as a figure rather than offered as a field. Rate and
 * less are still the desk's, so they are still the row's two text boxes.
 */
const lineRows = () =>
  screen
    .queryAllByRole("row")
    .filter((row) => within(row).queryByText(/^SK6$/))
    .map((row) => {
      const cells = within(row).getAllByRole("cell");
      const inputs = within(row).getAllByRole("textbox") as HTMLInputElement[];
      const dozens = within(cells[2]).getByText(/^[\d.]+$/).textContent;
      return [within(row).getByText(/^SK6$/).textContent, dozens, inputs[0].value, inputs[1].value];
    });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SaleVoucherFormPage from a gatepass", () => {
  it("fills party, date and one line per article + size (all colours, cartons → dozens, party rate and less) without saving anything, then saves linked to the gatepass and stays on it to print", async () => {
    const api = setupDesktop();
    renderPage({ fromGatepassId: "gp-7" });

    await screen.findByText("Filled from Gatepass GP-000007");
    expect(api.getGatepass).toHaveBeenCalledWith("gp-7", { token: "token-bill" });
    expect(screen.getByTestId("gatepass-link-chip")).toHaveTextContent("From Gatepass GP-000007");
    expect(screen.getByTestId("party-card")).toHaveTextContent("ABC Traders");
    expect(screen.getByTestId("party-card")).toHaveTextContent("P-0001 · Lahore");
    expect(screen.getByDisplayValue("2026-09-18")).toBeInTheDocument();
    // Remarks are left blank for the desk to write the sub party in Urdu.
    expect(screen.getByLabelText(copy.billing.remarksUrdu)).toHaveValue("");
    // BLUE 20 + RED 10 cartons → one SK6 7/10 line of 15 dozens at Rs 550 less Rs 10 / pair. No colour anywhere.
    expect(lineRows()).toEqual([["SK6", "15", "550", "10"]]);
    expect(screen.queryByText(/BLUE|RED/)).not.toBeInTheDocument();
    expect(api.resolveProductDiscountWithPrice).toHaveBeenCalledWith("p-abc", "v-sk6-blue", 550);
    expect(screen.getByTestId("bill-totals")).toHaveTextContent("Rs 97,200.00");
    // Rs 185,000 owed + Rs 97,200 = Rs 282,200 against a Rs 250,000 limit.
    await waitFor(() => expect(screen.getByTestId("bill-projection")).toHaveTextContent("Exceeds limit by Rs 32,200"));
    expect(screen.getByTestId("bill-credit")).toHaveTextContent("Limit Rs 250,000");
    expect(api.createSaleVoucher).not.toHaveBeenCalled();
    expect(api.addVoucherLineItem).not.toHaveBeenCalled();
    expect(screen.getByTestId("print-voucher")).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create Voucher/ }));
    });

    await waitFor(() => expect(api.createSaleVoucher).toHaveBeenCalledTimes(1));
    expect(api.createSaleVoucher.mock.calls[0][0]).toMatchObject({ partyId: "p-abc", voucherDate: "2026-09-18", gatepassId: "gp-7", remarks: "", projectedTotal: 97200 });
    expect(api.addVoucherLineItem.mock.calls.map((c) => c[1])).toEqual([
      { productVariantId: "v-sk6-blue", quantity: 15, unitPrice: 550, discount: 1800, priceType: "NORMAL" },
    ]);
    // The saved bill stays on screen, linked, and can be printed.
    await waitFor(() => expect(screen.getByTestId("print-voucher")).toBeEnabled());
    expect(screen.getByTestId("voucher-number")).toHaveTextContent("45");
    expect(screen.getByTestId("gatepass-link-chip")).toHaveTextContent("From Gatepass GP-000007");
  });

  it("will not let the desk change what went out: the quantity is a figure, and no line can be removed", async () => {
    setupDesktop();
    renderPage({ fromGatepassId: "gp-7" });
    await screen.findByText("Filled from Gatepass GP-000007");

    // The gatepass said 15 dozen, so there is nothing to type it into...
    expect(screen.queryByLabelText("Dzn SK6 7/10")).not.toBeInTheDocument();
    expect(lineRows()).toEqual([["SK6", "15", "550", "10"]]);
    // ...and nothing to take the line off the bill with.
    expect(screen.queryByRole("button", { name: /Remove SK6 7\/10/ })).not.toBeInTheDocument();

    // What the goods are WORTH is still the desk's, and the screen says which is which.
    expect(screen.getByLabelText("Rate / pair SK6 7/10")).toBeEnabled();
    expect(screen.getByLabelText("Less / pair SK6 7/10")).toBeEnabled();
    expect(screen.getByText(/Quantities come from GP-000007/)).toBeInTheDocument();
  });

  it("re-resolves the less whenever a line's rate is retyped, and keeps a less typed by hand until then", async () => {
    const api = setupDesktop();
    renderPage({ fromGatepassId: "gp-7" });
    await screen.findByText("Filled from Gatepass GP-000007");
    expect(lineRows()).toEqual([["SK6", "15", "550", "10"]]);

    fireEvent.change(screen.getByLabelText("Rate / pair SK6 7/10"), { target: { value: "600" } });
    await waitFor(() => expect(api.resolveProductDiscountWithPrice).toHaveBeenCalledWith("p-abc", "v-sk6-blue", 600));
    await waitFor(() => expect(lineRows()).toEqual([["SK6", "15", "600", "15"]]));
    expect(screen.getByText("Price", { exact: false })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Less / pair SK6 7/10"), { target: { value: "5" } });
    await waitFor(() => expect(lineRows()).toEqual([["SK6", "15", "600", "5"]]));
    expect(screen.queryByText("Price", { exact: false })).not.toBeInTheDocument();
    expect(screen.getByTestId("bill-totals")).toHaveTextContent("Rs 107,100.00");
  });

  it("with nothing on screen, a gatepass number starts the bill", async () => {
    const api = setupDesktop();
    renderPage();

    const picker = await screen.findByTestId("bill-empty");
    expect(picker).toHaveTextContent("Bills are made from gatepasses");
    fireEvent.change(screen.getByTestId("bill-gatepass-number"), { target: { value: "7" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("bill-gatepass-pick"));
    });

    await screen.findByText("Filled from Gatepass GP-000007");
    expect(api.getGatepassByNumber).toHaveBeenCalledWith(7, { token: "token-bill" });
    expect(lineRows()).toEqual([["SK6", "15", "550", "10"]]);
  });

  it("opens the bill already made from the gatepass instead of filling a second one", async () => {
    const api = setupDesktop({ findSaleVoucherByGatepass: vi.fn(async () => ({ id: "sv-1", voucherNumber: "45" })), listSaleVouchers: vi.fn(async () => ({ rows: [{ id: "sv-1", voucherNumber: "45" }], total: 1, page: 1, pageSize: 1000 })) });
    renderPage({ fromGatepassId: "gp-7" });

    await screen.findByText("Already billed");
    expect(api.getSaleVoucher).toHaveBeenCalledWith("sv-1");
    expect(api.getGatepass).not.toHaveBeenCalled();
    expect(screen.getByTestId("voucher-number")).toHaveTextContent("45");
    expect(screen.getByTestId("gatepass-link-chip")).toHaveTextContent("From Gatepass GP-000007");
    expect(lineRows()).toHaveLength(2);
  });

  it("a reopened bill follows the party's rules as they stand now: a line saved before its rule existed picks the rule up, a line the clerk typed keeps its figure", async () => {
    const api = setupDesktop({
      findSaleVoucherByGatepass: vi.fn(async () => ({ id: "sv-1", voucherNumber: "45" })),
      listSaleVouchers: vi.fn(async () => ({ rows: [{ id: "sv-1", voucherNumber: "45" }], total: 1, page: 1, pageSize: 1000 })),
      getSaleVoucher: vi.fn(async () => {
        const voucher = savedVoucher(GATEPASS);
        // The clerk had typed Rs 5 over the Rs 10 rule on the first line (10 dozen × 12 × 5).
        voucher.lineItems[0] = { ...voucher.lineItems[0], discount: 600 };
        return voucher;
      }),
    });
    renderPage({ fromGatepassId: "gp-7" });

    await screen.findByText("Already billed");
    // Line 1: the clerk's Rs 5 stands. Line 2: saved with no rule at Rs 600; the Rs 15 price-range rule now applies.
    expect(lineRows()).toEqual([["SK6", "10", "550", "5"], ["SK6", "5", "600", "15"]]);
    expect(api.resolveProductDiscountWithPrice).toHaveBeenCalledTimes(1);
    expect(api.resolveProductDiscountWithPrice).toHaveBeenCalledWith("p-abc", "v-sk6-red", 600);
    // 10 dz × 12 × 550 − 600 = 65,400 and 5 dz × 12 × 600 − 900 = 35,100.
    expect(screen.getByTestId("bill-totals")).toHaveTextContent("Rs 100,500.00");
  });

  it("when the backend refuses because the gatepass was billed meanwhile, opens that bill", async () => {
    const api = setupDesktop({
      createSaleVoucher: vi.fn(async (_input: Record<string, unknown>) => ({ accepted: false, errorCode: "GATEPASS_ALREADY_BILLED", reason: "GP-000007 already has Sale Voucher #45.", existingVoucherId: "sv-1", existingVoucherNumber: "45" })),
      listSaleVouchers: vi.fn(async () => ({ rows: [{ id: "sv-1", voucherNumber: "45" }], total: 1, page: 1, pageSize: 1000 })),
    });
    renderPage({ fromGatepassId: "gp-7" });
    await screen.findByText("Filled from Gatepass GP-000007");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create Voucher/ }));
    });
    await screen.findByText("GP-000007 already has Sale Voucher #45.");
    expect(api.addVoucherLineItem).not.toHaveBeenCalled();
    await waitFor(() => expect(api.getSaleVoucher).toHaveBeenCalledWith("sv-1"));
  });

  it("a bill whose gatepass was cancelled shows the loud banner with the one fix: delete this voucher", async () => {
    const api = setupDesktop({
      findSaleVoucherByGatepass: vi.fn(async () => ({ id: "sv-1", voucherNumber: "45" })),
      listSaleVouchers: vi.fn(async () => ({ rows: [{ id: "sv-1", voucherNumber: "45" }], total: 1, page: 1, pageSize: 1000 })),
      getSaleVoucher: vi.fn(async () => savedVoucher({ id: "gp-7", code: "GP-000007", status: "CANCELLED" })),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage({ fromGatepassId: "gp-7" });

    const banner = await screen.findByTestId("gatepass-cancelled-bill-banner");
    expect(banner).toHaveTextContent("Gatepass GP-000007 was cancelled");
    expect(banner).toHaveTextContent("must be deleted");
    expect(screen.queryByTestId("gatepass-link-chip")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-bill-for-cancelled-gatepass"));
    });
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(api.deleteSaleVoucher).toHaveBeenCalledWith("sv-1"));
    expect(screen.queryByTestId("gatepass-cancelled-bill-banner")).not.toBeInTheDocument();
  });

  it("a cancelled gatepass with no bill is not filled in — the desk is told there is nothing to do", async () => {
    const api = setupDesktop({ getGatepass: vi.fn(async () => ({ ...GATEPASS, status: "CANCELLED" as const })) });
    renderPage({ fromGatepassId: "gp-7" });

    await screen.findByText("GP-000007 was cancelled and no bill was made from it — nothing to do.");
    expect(screen.queryByTestId("gatepass-link-chip")).not.toBeInTheDocument();
    expect(lineRows()).toEqual([]);
    expect(api.createSaleVoucher).not.toHaveBeenCalled();
  });
});
