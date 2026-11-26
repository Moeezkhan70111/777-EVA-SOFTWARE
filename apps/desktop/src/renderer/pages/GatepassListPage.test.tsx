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
  issuedDirectlyQuantity: 0,
  outstandingQuantity: 80,
  lineCount: 3,
  createdBy: "clerk",
  createdAt: "2026-09-16T10:00:00.000Z",
  updatedAt: "2026-09-16T10:00:00.000Z",
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  revisionNo: 1, editedAt: null, editedBy: null, deletedAt: null, deletedBy: null, deleteReason: null, versions: [],
  lines: [
    { id: "l1", lineNo: 1, productVariantId: "v1", groupName: null, article: "SK6", color: "RED", size: "7/10", quantity: 50, storeQuantityAtCreation: 120, dispatchedFromStoreQuantity: 0, issuedDirectlyQuantity: 0, outstandingQuantity: 50 },
    { id: "l2", lineNo: 2, productVariantId: "v2", groupName: null, article: "SK6", color: "BLUE", size: "7/10", quantity: 20, storeQuantityAtCreation: 80, dispatchedFromStoreQuantity: 0, issuedDirectlyQuantity: 0, outstandingQuantity: 20 },
    { id: "l3", lineNo: 3, productVariantId: "v3", groupName: null, article: "SK6", color: "RED", size: "4/6", quantity: 10, storeQuantityAtCreation: 50, dispatchedFromStoreQuantity: 0, issuedDirectlyQuantity: 0, outstandingQuantity: 10 },
  ],
};

const ROWS: GatepassListRow[] = [
  { id: "gp-1", code: "GP-000123", gatepassNumber: 123, partyId: "p-abc", partyName: "ABC TRADERS", gatepassDate: "2026-09-16", status: "CREATED", totalQuantity: 80, dispatchedFromStoreQuantity: 0, issuedDirectlyQuantity: 0, outstandingQuantity: 80, lineCount: 3, articles: ["SK6"], createdBy: "clerk", createdAt: "2026-09-16T10:00:00.000Z" },
  { id: "gp-2", code: "GP-000122", gatepassNumber: 122, partyId: "p-xyz", partyName: "XYZ TRADERS", gatepassDate: "2026-09-16", status: "CREATED", totalQuantity: 45, dispatchedFromStoreQuantity: 0, issuedDirectlyQuantity: 0, outstandingQuantity: 45, lineCount: 2, articles: ["SK12", "SK8"], createdBy: "clerk", createdAt: "2026-09-16T09:00:00.000Z" },
  { id: "gp-3", code: "GP-000121", gatepassNumber: 121, partyId: "p-abc", partyName: "ABC TRADERS", gatepassDate: "2026-09-15", status: "CANCELLED", totalQuantity: 90, dispatchedFromStoreQuantity: 0, issuedDirectlyQuantity: 0, outstandingQuantity: 90, lineCount: 4, articles: ["SK6"], createdBy: "clerk", createdAt: "2026-09-15T09:00:00.000Z" },
];

function createFakeBackend() {
  const docs = new Map<string, Gatepass>([["gp-1", { ...DOC }]]);
  const api = {
    listParties: vi.fn(async () => ({ rows: [{ id: "p-abc", partyCode: "P-0001", partyName: "ABC TRADERS", partyType: "CUSTOMER", status: "ACTIVE", createdAt: "" }], total: 1, page: 1, pageSize: 1000 })),
    listUniqueArticles: vi.fn(async () => ["SK6", "SK8", "SK12"]),
    listGatepasses: vi.fn(async (query: any) => {
      // The deleted log lists only deleted gatepasses (local migration 118); the list never does.
      const deleted = [...docs.values()].filter((d) => d.deletedAt);
      if (query.deleted === true) {
        const log = deleted.map((d) => ({ ...ROWS[0], id: d.id, code: d.code, status: d.status, deletedAt: d.deletedAt, deletedBy: d.deletedBy, deleteReason: d.deleteReason }));
        return { rows: log, total: log.length, page: 1, pageSize: 25 };
      }
      let rows = ROWS.filter((r) => !deleted.some((d) => d.id === r.id));
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
    deleteGatepass: vi.fn(async (input: { gatepassId: string; reason: string }) => {
      const doc = docs.get(input.gatepassId)!;
      if (doc.status !== "CANCELLED") return { accepted: false, outcome: "NOT_CANCELLED", reason: `${doc.code} is not cancelled.` };
      docs.set(input.gatepassId, { ...doc, deletedAt: "2026-09-17T09:00:00.000Z", deletedBy: "manager", deleteReason: input.reason });
      return { accepted: true, outcome: "DELETED", gatepassId: input.gatepassId, code: doc.code };
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
      // Quantities in dozens (owner, 23 Nov 2026): 80 cartons is 40 dozen, 45 is 22.5.
      ["GP-000123", d16, "ABC TRADERS", "SK6", "3", "40", "0", "Gatepass Issued", "clerk"],
      ["GP-000122", d16, "XYZ TRADERS", "SK12, SK8", "2", "22.5", "0", "Gatepass Issued", "clerk"],
      ["GP-000121", d15, "ABC TRADERS", "SK6", "4", "45", "0", "Cancelled", "clerk"],
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
    expect(screen.getByTestId("gatepass-detail-total")).toHaveTextContent("40 DZN");
    expect(screen.getByTestId("gatepass-detail-bilty")).toHaveTextContent("B-4471");
    expect(screen.getByTestId("gatepass-detail-via")).toHaveTextContent("Daewoo Cargo");

    // Article + size rows, colour columns, totals — the same shape as the paper book.
    const grid = screen.getByTestId("gatepass-detail-grid");
    expect(within(grid).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Article", "Size", "BLUE", "RED", "Total (DZN)"]);
    const bodyRows = within(grid).getAllByRole("row").slice(1, 3);
    expect(bodyRows.map((r) => [within(r).getByRole("rowheader").textContent, ...within(r).getAllByRole("cell").map((c) => c.textContent)])).toEqual([
      ["SK6", "4/6", "", "5", "5"],
      ["SK6", "7/10", "10", "25", "35"],
    ]);
    const foot = within(grid).getAllByRole("row").at(-1)!;
    expect(within(foot).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Total", "10", "30", "40"]);
    // The store's progress on the document, and the line-by-line detail (moved out /
    // outstanding per line, In Store when cut) one level down.
    expect(screen.getByTestId("gatepass-detail-moved-out")).toHaveTextContent("0 of 40 DZN moved out");
    const lines = within(detail).getAllByRole("row").filter((r) => within(r).queryAllByRole("cell").length === 8);
    expect(lines.map((r) => within(r).getAllByRole("cell").slice(1, 8).map((c) => c.textContent))).toEqual([
      ["SK6", "RED", "7/10", "25", "0", "25", "60"],
      ["SK6", "BLUE", "7/10", "10", "0", "10", "40"],
      ["SK6", "RED", "4/6", "5", "0", "5", "25"],
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
    // The printed grid: colour columns, one row per article + size, row and colour totals, in dozens.
    expect(written).toMatch(/<th scope="col">BLUE<\/th>\s*<th scope="col">RED<\/th>/);
    expect(written).toMatch(/<th scope="row">SK6<\/th>\s*<td class="size">7\/10<\/td>\s*<td>10<\/td>\s*<td>25<\/td>\s*<td class="total">35<\/td>/);
    expect(written).toContain("Total (DZN)");
    expect(written).not.toContain("cartons");
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

  // The QR printed on a sale voucher (owner, 26 Nov 2026): a scanner types it into the search, and its gatepass opens.
  it("opens the gatepass whose bill QR is scanned into the search, without searching for the code", async () => {
    const { api } = createFakeBackend();
    const id = "3f2b9c1e-8a4d-4c55-9e1f-2a7b6c0d9e11";
    api.getGatepass.mockImplementation(async (asked: string) => (asked === id ? { ...DOC, id } : null));
    renderPage();
    await screen.findByTestId("gatepass-row-GP-000123");
    const search = screen.getByLabelText(/search/i);
    await act(async () => { fireEvent.change(search, { target: { value: `GPQR_${id}` } }); });
    expect(await screen.findByTestId("gatepass-detail")).toBeInTheDocument();
    expect(api.getGatepass).toHaveBeenCalledWith(id, { token: "token-1" });
    // The code is never sent to the list as a search.
    expect(api.listGatepasses.mock.calls.some(([query]) => String((query as { search?: string }).search ?? "").includes("GPQR"))).toBe(false);
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

// Cartons with no QR are issued directly when the gatepass is made (docs/42 section 10.2): the
// document and the list say so, and never call them scanned or moved out.
describe("a gatepass that issued cartons directly", () => {
  const line = (quantity: number, issued: number, scanned: number) => ({
    id: "lm", lineNo: 1, productVariantId: "v1", groupName: null, article: "SK6", color: "RED", size: "7/10",
    quantity, storeQuantityAtCreation: 13, dispatchedFromStoreQuantity: scanned, issuedDirectlyQuantity: issued, outstandingQuantity: quantity - issued - scanned,
  });
  const doc = (id: string, status: Gatepass["status"], quantity: number, issued: number, scanned: number): Gatepass => ({
    ...DOC, id, status, totalQuantity: quantity, lineCount: 1, dispatchedFromStoreQuantity: scanned, issuedDirectlyQuantity: issued,
    outstandingQuantity: quantity - issued - scanned, lines: [line(quantity, issued, scanned)],
  });

  it("manual only, billed: 'All cartons issued — No Store Scan Required', every figure stated, and no desk offered", async () => {
    const { docs } = createFakeBackend();
    docs.set("gp-manual", doc("gp-manual", "BILLED", 4, 4, 0));
    renderPage({ initialGatepassId: "gp-manual" });
    expect(await screen.findByTestId("gatepass-detail-moved-out")).toHaveTextContent("All cartons issued — No Store Scan Required");
    expect(screen.getByTestId("gatepass-detail-figures")).toHaveTextContent("Issued directly: 2 · Scanned out: 0 · Remaining to scan: 0 DZN");
    expect(screen.queryByTestId("gatepass-open-store-scan")).not.toBeInTheDocument();
    expect(screen.queryByTestId("gatepass-open-dispatch-scan")).not.toBeInTheDocument();
  });

  it("mixed: issued, scanned and remaining each in its own place, and the issued cartons are never called scanned", async () => {
    const { docs } = createFakeBackend();
    docs.set("gp-mixed", doc("gp-mixed", "BILLED", 5, 2, 1));
    renderPage({ initialGatepassId: "gp-mixed" });
    expect(await screen.findByTestId("gatepass-detail-moved-out")).toHaveTextContent("2 cartons issued directly. Scan the remaining 2 QR cartons.");
    expect(screen.getByTestId("gatepass-detail-figures")).toHaveTextContent("Issued directly: 1 · Scanned out: 0.5 · Remaining to scan: 1 DZN");
    expect(screen.getByTestId("gatepass-open-store-scan")).toBeInTheDocument();

    const lines = document.querySelector(".gp-lines-table") as HTMLTableElement;
    const headers = within(lines).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(["Issued directly", "Scanned out", "Remaining to scan"]));
    expect(headers).not.toContain("Moved out");
    const cells = within(within(lines).getAllByRole("row")[1]!).getAllByRole("cell").map((c) => c.textContent);
    // 5, 2, 1 and 2 cartons, in dozens.
    expect(cells.slice(4, 8)).toEqual(["2.5", "1", "0.5", "1"]);
  });

  it("the list row shows what was scanned out apart from what was issued", async () => {
    const { api } = createFakeBackend();
    api.listGatepasses.mockResolvedValue({
      rows: [{ ...ROWS[0]!, code: "GP-000200", totalQuantity: 5, dispatchedFromStoreQuantity: 1, issuedDirectlyQuantity: 2, outstandingQuantity: 2 }],
      total: 1, page: 1, pageSize: 25,
    });
    renderPage();
    expect(await screen.findByTestId("gatepass-row-moved-out-GP-000200")).toHaveTextContent("0.5 · 1 DZN issued directly");
  });
});

// EDIT AND DELETE on the list (local migration 118): Edit hands the gatepass to the Gatepass screen; a cancelled
// gatepass may be deleted with a reason, leaves the list, and is read on the Deleted gatepasses log.
describe("GatepassListPage edit and delete", () => {
  const openGp1 = async () => {
    fireEvent.click(await screen.findByTestId("gatepass-row-GP-000123"));
    await screen.findByTestId("gatepass-detail");
  };

  it("offers Edit to someone who may edit, and hands the gatepass to the Gatepass screen", async () => {
    createFakeBackend();
    const onEdit = vi.fn();
    renderPage({ onEdit });
    await openGp1();
    fireEvent.click(screen.getByTestId("gatepass-list-edit"));
    expect(onEdit).toHaveBeenCalledWith("gp-1");
  });

  it("offers no Edit or Delete without the permissions", async () => {
    createFakeBackend();
    renderPage();
    await openGp1();
    expect(screen.queryByTestId("gatepass-list-edit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("gatepass-delete-open")).not.toBeInTheDocument();
  });

  it("deletes a cancelled gatepass with a reason; it leaves the list and is read on the deleted log", async () => {
    const { api, docs } = createFakeBackend();
    docs.set("gp-1", { ...docs.get("gp-1")!, status: "CANCELLED", cancelledAt: "2026-09-16T12:00:00.000Z", cancelledBy: "manager", cancelReason: "wrong party" });
    renderPage({ canDelete: true });
    await openGp1();

    fireEvent.click(screen.getByTestId("gatepass-delete-open"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-delete-confirm"));
    });
    expect(within(screen.getByTestId("gatepass-delete-panel")).getByRole("alert")).toHaveTextContent("Say why it is being deleted.");
    expect(api.deleteGatepass).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.change(within(screen.getByTestId("gatepass-delete-panel")).getByLabelText("Reason"), { target: { value: "made in error" } });
      fireEvent.click(screen.getByTestId("gatepass-delete-confirm"));
    });
    await waitFor(() => expect(api.deleteGatepass).toHaveBeenCalledWith({ gatepassId: "gp-1", reason: "made in error" }, { token: "token-1" }));
    expect(await screen.findByTestId("gatepass-deleted-banner")).toHaveTextContent("Deleted by manager");
    expect(screen.queryByTestId("gatepass-delete-open")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("← Gatepass List"));
    await waitFor(() => expect(screen.queryByTestId("gatepass-row-GP-000123")).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId("gatepass-deleted-toggle"));
    const log = await screen.findByTestId("gatepass-deleted-log");
    expect(within(log).getByTestId("gatepass-deleted-GP-000123")).toHaveTextContent("made in error");
  });
});
