import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatepassListPage, defaultStageFor } from "./GatepassListPage";
import { PERMISSION } from "@erp/domain";
import { NotificationsProvider } from "../state/NotificationsContext";
import type { Gatepass, GatepassListRow } from "../types/desktopApi";
import { formatGatepassDate } from "../utils/gatepassPrint";

const d16 = formatGatepassDate("2026-09-16");
const d15 = formatGatepassDate("2026-09-15");

const DOC: Gatepass = {
  id: "gp-1",
  code: "GP-000123",
  gatepassNumber: 123,
  partyId: "p-abc",
  partyName: "ABC TRADERS",
  partyCode: "P-0001",
  partyCity: "Lahore",
  gatepassDate: "2026-09-16",
  status: "CREATED",
  biltyNumber: "B-4471",
  transportVia: "Daewoo Cargo",
  remarks: null,
  totalQuantity: 80,
  dispatchedFromStoreQuantity: 0,
  outstandingQuantity: 80,
  lineCount: 3,
  createdBy: "clerk",
  createdAt: "2026-09-16T10:00:00.000Z",
  updatedAt: "2026-09-16T10:00:00.000Z",
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  lines: [
    { id: "l1", lineNo: 1, productVariantId: "v1", groupName: null, article: "SK6", color: "RED", size: "7/10", quantity: 50, storeQuantityAtCreation: 120, dispatchedFromStoreQuantity: 0, outstandingQuantity: 50 },
    { id: "l2", lineNo: 2, productVariantId: "v2", groupName: null, article: "SK6", color: "BLUE", size: "7/10", quantity: 20, storeQuantityAtCreation: 80, dispatchedFromStoreQuantity: 0, outstandingQuantity: 20 },
    { id: "l3", lineNo: 3, productVariantId: "v3", groupName: null, article: "SK6", color: "RED", size: "4/6", quantity: 10, storeQuantityAtCreation: 50, dispatchedFromStoreQuantity: 0, outstandingQuantity: 10 },
  ],
};

const ROWS: GatepassListRow[] = [
  { id: "gp-1", code: "GP-000123", gatepassNumber: 123, partyId: "p-abc", partyName: "ABC TRADERS", gatepassDate: "2026-09-16", status: "CREATED", totalQuantity: 80, dispatchedFromStoreQuantity: 0, outstandingQuantity: 80, lineCount: 3, articles: ["SK6"], createdBy: "clerk", createdAt: "2026-09-16T10:00:00.000Z" },
  { id: "gp-2", code: "GP-000122", gatepassNumber: 122, partyId: "p-xyz", partyName: "XYZ TRADERS", gatepassDate: "2026-09-16", status: "CREATED", totalQuantity: 45, dispatchedFromStoreQuantity: 0, outstandingQuantity: 45, lineCount: 2, articles: ["SK12", "SK8"], createdBy: "clerk", createdAt: "2026-09-16T09:00:00.000Z" },
  { id: "gp-3", code: "GP-000121", gatepassNumber: 121, partyId: "p-abc", partyName: "ABC TRADERS", gatepassDate: "2026-09-15", status: "CANCELLED", totalQuantity: 90, dispatchedFromStoreQuantity: 0, outstandingQuantity: 90, lineCount: 4, articles: ["SK6"], createdBy: "clerk", createdAt: "2026-09-15T09:00:00.000Z" },
];

function createFakeBackend() {
  const docs = new Map<string, Gatepass>([["gp-1", { ...DOC }]]);
  const api = {
    listParties: vi.fn(async () => ({ rows: [{ id: "p-abc", partyCode: "P-0001", partyName: "ABC TRADERS", partyType: "CUSTOMER", status: "ACTIVE", createdAt: "" }], total: 1, page: 1, pageSize: 1000 })),
    listUniqueArticles: vi.fn(async () => ["SK6", "SK8", "SK12"]),
    listGatepasses: vi.fn(async (query: any) => {
      let rows = ROWS;
      if (query.status && query.status !== "ALL") rows = rows.filter((r) => r.status === query.status);
      if (query.search) rows = rows.filter((r) => r.code.includes(query.search) || r.partyName.toLowerCase().includes(String(query.search).toLowerCase()));
      return { rows, total: rows.length, page: 1, pageSize: 25 };
    }),
    getGatepass: vi.fn(async (id: string) => docs.get(id) ?? null),
    cancelGatepass: vi.fn(async (input: { gatepassId: string; reason: string }) => {
      const doc = docs.get(input.gatepassId);
      if (!doc) return { accepted: false, outcome: "NOT_FOUND", reason: "This Gatepass could not be found." };
      if (doc.status === "CANCELLED") return { accepted: false, outcome: "ALREADY_CANCELLED", reason: `${doc.code} has already been cancelled.` };
      docs.set(input.gatepassId, { ...doc, status: "CANCELLED", cancelledAt: "2026-09-16T12:00:00.000Z", cancelledBy: "manager", cancelReason: input.reason });
      return { accepted: true, outcome: "CANCELLED", gatepassId: input.gatepassId, code: doc.code, cancelledAt: "2026-09-16T12:00:00.000Z" };
    }),
  };
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
  return { api, docs };
}

const renderPage = (props: Partial<React.ComponentProps<typeof GatepassListPage>> = {}) => {
  const onNavigate = vi.fn();
  const utils = render(
    <NotificationsProvider>
      <GatepassListPage token="token-1" username="manager" canCancel onNavigate={onNavigate} {...props} />
    </NotificationsProvider>
  );
  return { ...utils, onNavigate };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GatepassListPage", () => {
  it("lists gatepasses newest first with number, date, party, articles, items, quantity and status", async () => {
    createFakeBackend();
    renderPage();
    const table = await screen.findByTestId("gatepass-list-table");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(4));
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell").map((c) => c.textContent))).toEqual([
      ["GP-000123", d16, "ABC TRADERS", "SK6", "3", "80", "0", "Gatepass Issued", "clerk"],
      ["GP-000122", d16, "XYZ TRADERS", "SK12, SK8", "2", "45", "0", "Gatepass Issued", "clerk"],
      ["GP-000121", d15, "ABC TRADERS", "SK6", "4", "90", "0", "Cancelled", "clerk"],
    ]);
    expect(table.textContent).not.toMatch(/amount|rate|discount/i);
  });

  it("passes search and status filters to the backend with the session token", async () => {
    const { api } = createFakeBackend();
    renderPage();
    await screen.findByTestId("gatepass-row-GP-000123");

    // Status is chosen by the stage tabs now; Cancelled lives behind All, which clears the filter.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^All$/ }));
    });
    await waitFor(() => expect(api.listGatepasses).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ALL", page: 1 }), { token: "token-1" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Pending Billing/ }));
    });
    await waitFor(() => expect(api.listGatepasses).toHaveBeenLastCalledWith(expect.objectContaining({ status: "CREATED", page: 1 }), { token: "token-1" }));

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "xyz" } });
    });
    await waitFor(() => expect(api.listGatepasses).toHaveBeenLastCalledWith(expect.objectContaining({ search: "xyz", status: "CREATED" }), { token: "token-1" }));
  });

  it("opens a gatepass, shows it as the book's grid with bilty / via and no money fields, prints it, and cancels it with a reason", async () => {
    const { api } = createFakeBackend();
    const openSpy = vi.spyOn(window, "open").mockReturnValue({ document: { write: vi.fn(), close: vi.fn() } } as unknown as Window);
    renderPage();

    const row = await screen.findByTestId("gatepass-row-GP-000123");
    await act(async () => {
      fireEvent.click(row);
    });
    const detail = await screen.findByTestId("gatepass-detail");
    expect(screen.getByText("Gatepass GP-000123")).toBeInTheDocument();
    expect(within(detail).getByText("ABC TRADERS")).toBeInTheDocument();
    expect(within(detail).getByText("clerk")).toBeInTheDocument();
    expect(screen.getByTestId("gatepass-detail-total")).toHaveTextContent("80 cartons");
    expect(screen.getByTestId("gatepass-detail-bilty")).toHaveTextContent("B-4471");
    expect(screen.getByTestId("gatepass-detail-via")).toHaveTextContent("Daewoo Cargo");

    // Article + size rows, colour columns, totals — the same shape as the paper book.
    const grid = screen.getByTestId("gatepass-detail-grid");
    expect(within(grid).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Article", "Size", "BLUE", "RED", "Total"]);
    const bodyRows = within(grid).getAllByRole("row").slice(1, 3);
    expect(bodyRows.map((r) => [within(r).getByRole("rowheader").textContent, ...within(r).getAllByRole("cell").map((c) => c.textContent)])).toEqual([
      ["SK6", "4/6", "", "10", "10"],
      ["SK6", "7/10", "20", "50", "70"],
    ]);
    const foot = within(grid).getAllByRole("row").at(-1)!;
    expect(within(foot).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Total", "20", "60", "80"]);
    // The store's progress on the document, and the line-by-line detail (moved out /
    // outstanding per line, In Store when cut) one level down.
    expect(screen.getByTestId("gatepass-detail-moved-out")).toHaveTextContent("0 of 80 moved out");
    const lines = within(detail).getAllByRole("row").filter((r) => within(r).queryAllByRole("cell").length === 8);
    expect(lines.map((r) => within(r).getAllByRole("cell").slice(1, 8).map((c) => c.textContent))).toEqual([
      ["SK6", "RED", "7/10", "50", "0", "50", "120"],
      ["SK6", "BLUE", "7/10", "20", "0", "20", "80"],
      ["SK6", "RED", "4/6", "10", "0", "10", "50"],
    ]);
    expect(detail.textContent).not.toMatch(/rate|discount|amount|balance|scanned/i);

    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-print"));
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
    const printWindow = openSpy.mock.results[0].value as any;
    await waitFor(() => expect(printWindow.document.write).toHaveBeenCalledTimes(1));
    const written = printWindow.document.write.mock.calls[0][0] as string;
    expect(written).toContain("GATE PASS");
    expect(written).toContain("GP-000123");
    expect(written).toContain("ABC TRADERS");
    expect(written).toContain("B-4471");
    expect(written).toContain("Daewoo Cargo");
    expect(written).toContain("16/09/2026");
    // The printed grid: colour columns, one row per article + size, row and colour totals.
    expect(written).toMatch(/<th scope="col">BLUE<\/th>\s*<th scope="col">RED<\/th>/);
    expect(written).toMatch(/<th scope="row">SK6<\/th>\s*<td class="size">7\/10<\/td>\s*<td>20<\/td>\s*<td>50<\/td>\s*<td class="total">70<\/td>/);
    expect(written).toContain("Total cartons");
    expect(written).not.toMatch(/rate|discount|amount|subtotal|grand total|balance|payment|invoice/i);

    // Cancel: a reason is required, then the document is marked and its lines kept.
    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-cancel-open"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-cancel-confirm"));
    });
    expect(await screen.findByText("Give a reason for cancelling this Gatepass.")).toBeInTheDocument();
    expect(api.cancelGatepass).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "wrong party" } });
      fireEvent.click(screen.getByTestId("gatepass-cancel-confirm"));
    });
    await waitFor(() => expect(api.cancelGatepass).toHaveBeenCalledWith({ gatepassId: "gp-1", reason: "wrong party" }, { token: "token-1" }));
    const banner = await screen.findByTestId("gatepass-cancelled-banner");
    expect(banner).toHaveTextContent("Cancelled");
    expect(banner).toHaveTextContent("by manager — wrong party");
    expect(screen.queryByTestId("gatepass-cancel-open")).not.toBeInTheDocument();
    // The lines are kept: the grid still shows both rows and the audit detail all three lines.
    expect(within(screen.getByTestId("gatepass-detail-grid")).getAllByRole("row").slice(1, 3)).toHaveLength(2);
    expect(within(screen.getByTestId("gatepass-detail")).getAllByRole("row").filter((r) => within(r).queryAllByRole("cell").length === 8)).toHaveLength(3);
  });

  it("hides the cancel action from users without the cancel permission", async () => {
    createFakeBackend();
    renderPage({ canCancel: false, initialGatepassId: "gp-1" });
    await screen.findByTestId("gatepass-detail");
    expect(screen.getByTestId("gatepass-print")).toBeInTheDocument();
    expect(screen.queryByTestId("gatepass-cancel-open")).not.toBeInTheDocument();
  });

  it("falls back to the list when the initial id is not a gatepass", async () => {
    createFakeBackend();
    renderPage({ initialGatepassId: "some-product-id" });
    expect(await screen.findByTestId("gatepass-list-table")).toBeInTheDocument();
    expect(screen.queryByTestId("gatepass-detail")).not.toBeInTheDocument();
  });
});

// Which queue the list opens on. It only chooses where to land — every tab stays reachable.
describe("the queue the Gatepass list opens on", () => {
  it("opens a desk worker on their own queue", () => {
    expect(defaultStageFor([PERMISSION.STORE_SCANNING], false)).toBe("BILLED");
    expect(defaultStageFor([PERMISSION.SALE_VOUCHER_FORM], false)).toBe("CREATED");
    expect(defaultStageFor([PERMISSION.LIVE_DISPATCH], false)).toBe("AT_GATE");
  });

  it("opens an administrator, and anyone who works several desks, on the whole list", () => {
    expect(defaultStageFor([], true)).toBe("ALL");
    expect(defaultStageFor([PERMISSION.STORE_SCANNING, PERMISSION.LIVE_DISPATCH], false)).toBe("ALL");
  });

  it("opens a Munshi on the whole list, not on the Pending Builties desk they do not work", () => {
    // Their only gatepass permission is the plain one, which also gates Pending Builties.
    expect(defaultStageFor([PERMISSION.GATEPASS], false)).toBe("DISPATCHED");
    expect(defaultStageFor([PERMISSION.MUNSHI, PERMISSION.GATEPASS, PERMISSION.STOCK], false)).toBe("ALL");
  });
});
