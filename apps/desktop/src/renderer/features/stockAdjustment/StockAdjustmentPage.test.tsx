import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../../config/copy";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { StockAdjustmentPage } from "./StockAdjustmentPage";
import { entryProblem, mergeLines, totalsOf, type DraftLine } from "./stockAdjustmentDraft";

// STOCK ADJUSTMENT as an administrator meets it (docs/46): pick the article and colour, a quantity per size with the
// figure it leaves, the lines with totals, a Post that asks first. On a computer without the carton lease: read-only.
// Asserted in words (R18).

const text = copy.stockAdjustment;

const product = (article: string, size: string, colors: string[]) => ({
  id: `as-${article}-${size}`, articleSizeId: `as-${article}-${size}`, article, color: "", size, colors, description: null,
  costPrice: 300, sellingPrice: 550, mainGroupId: null, groupId: null, articleSeriesId: null, status: "ACTIVE", createdAt: "2024-01-01", updatedAt: "2024-01-01",
});
const choice = (size: string, inStore: number, hasOpening = false) => ({ articleSizeId: `as-SK6-${size}`, size, color: "RED", inStore, hasOpening });
const posted = {
  id: "d-1", code: "SA-000001", kind: "OPENING", businessDate: "2026-11-11", reason: "Opening count", remarks: null, postedBy: "owner",
  postedAt: "2026-11-11T05:00:00.000Z", cartonsIn: 55, cartonsOut: 0,
  lines: [{ lineNo: 1, article: "SK6", size: "7/10", color: "RED", direction: "IN", cartons: 20 }, { lineNo: 2, article: "SK6", size: "10/13", color: "RED", direction: "IN", cartons: 35 }],
};

let api: Record<string, ReturnType<typeof vi.fn>>;

const show = (canWrite = true) => {
  api.getWriteLeases.mockResolvedValue([
    { domain: "CARTON_STOCK", canWrite, reason: canWrite ? null : "HELD_ELSEWHERE", holderLabel: canWrite ? null : "PC 1 -- Manual Production" },
  ]);
  render(<NotificationsProvider><StockAdjustmentPage /></NotificationsProvider>);
};

const pick = async (field: string, option: string) => {
  await userEvent.click(await screen.findByRole("combobox", { name: field }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
};

beforeEach(() => {
  api = {
    getWriteLeases: vi.fn(),
    listProducts: vi.fn().mockResolvedValue({ rows: [product("SK6", "7/10", ["RED"]), product("SK6", "10/13", ["RED"]), product("SK6", "13/1", ["RED"])], total: 3, page: 1, pageSize: 1000 }),
    getCartonAdjustmentArticle: vi.fn().mockResolvedValue({ accepted: true, choices: [choice("10/13", 0), choice("7/10", 5, true), choice("13/1", 0)] }),
    listCartonStockAdjustments: vi.fn().mockResolvedValue({ accepted: true, page: { documents: [], total: 0, page: 1, pages: 1 } }),
    postCartonStockAdjustment: vi.fn().mockResolvedValue({ accepted: true, document: posted, duplicate: false }),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

describe("Stock Adjustment", () => {
  it("opening stock: sizes in store order, a locked size says it has opening, the preview, the lines and a Post that asks", async () => {
    show();
    await pick(text.articleLabel, "SK6");
    await pick(text.colorLabel, "RED");
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["7/10", "10/13", "13/1"]);
    expect(within(table).getByText(text.hasOpening)).toBeInTheDocument();

    await userEvent.type(screen.getByRole("textbox", { name: text.quantityFor("10/13") }), "35");
    await userEvent.type(screen.getByRole("textbox", { name: text.quantityFor("13/1") }), "12");
    const row = within(table).getByRole("rowheader", { name: "10/13" }).closest("tr") as HTMLTableRowElement;
    expect(Array.from(row.cells).map((cell) => cell.textContent)).toEqual(["10/13", "0", "", "35"]);
    await userEvent.click(screen.getByRole("button", { name: text.addToDocument }));

    const lines = screen.getByRole("region", { name: text.linesTitle });
    expect(within(lines).getByRole("row", { name: /^Total \+47 \/ −0/ })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: text.reasonLabel }), "Opening count");
    await userEvent.click(within(lines).getByRole("button", { name: text.post.OPENING }));
    expect(api.postCartonStockAdjustment).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole("button", { name: text.post.OPENING });
    await userEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(api.postCartonStockAdjustment).toHaveBeenCalledTimes(1));
    const sent = api.postCartonStockAdjustment.mock.calls[0]?.[0] as { requestId: string; kind: string; reason: string; lines: unknown[] };
    expect(sent.kind).toBe("OPENING");
    expect(sent.reason).toBe("Opening count");
    expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.lines).toEqual([
      { articleSizeId: "as-SK6-10/13", color: "RED", direction: "IN", cartons: 35 },
      { articleSizeId: "as-SK6-13/1", color: "RED", direction: "IN", cartons: 12 },
    ]);
    expect(await screen.findByText(text.posted("SA-000001", 55, 0))).toBeInTheDocument();
  });

  it("a decrease larger than the store holds is refused on the screen, and cannot be added", async () => {
    show();
    await userEvent.click(await screen.findByRole("tab", { name: text.kinds.ADJUSTMENT }));
    await pick(text.articleLabel, "SK6");
    await pick(text.colorLabel, "RED");
    await userEvent.click(screen.getByRole("button", { name: text.directions.OUT }));
    await userEvent.type(await screen.findByRole("textbox", { name: text.quantityFor("7/10") }), "9");
    expect(screen.getByRole("alert")).toHaveTextContent(text.notEnough(5));
    expect((screen.getByRole("button", { name: text.addToDocument }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a lease refusal on Post is said in words and nothing is claimed posted", async () => {
    api.postCartonStockAdjustment.mockRejectedValue(new Error("Error invoking remote method 'erp:post-carton-stock-adjustment': LeaseError: Carton stock is written on PC 1 only. It is read-only here."));
    show();
    await pick(text.articleLabel, "SK6");
    await pick(text.colorLabel, "RED");
    await userEvent.type(await screen.findByRole("textbox", { name: text.quantityFor("13/1") }), "4");
    await userEvent.click(screen.getByRole("button", { name: text.addToDocument }));
    await userEvent.type(screen.getByRole("textbox", { name: text.reasonLabel }), "count");
    await userEvent.click(screen.getByRole("button", { name: text.post.OPENING }));
    const buttons = screen.getAllByRole("button", { name: text.post.OPENING });
    await userEvent.click(buttons[buttons.length - 1]!);
    expect(await screen.findByText(/is read-only here/)).toBeInTheDocument();
    expect(screen.queryByText(text.postedTitle)).toBeNull();
  });

  it("on a computer without the carton lease: read-only notice, no form, the history still shows", async () => {
    api.listCartonStockAdjustments.mockResolvedValue({ accepted: true, page: { documents: [posted], total: 1, page: 1, pages: 1 } });
    show(false);
    expect(await screen.findByText(/written on PC 1 -- Manual Production only/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: text.articleLabel })).toBeNull();
    expect(await screen.findByText("SA-000001")).toBeInTheDocument();
  });

  it("shows a failure to read the history with a retry, never a blank list", async () => {
    api.listCartonStockAdjustments.mockResolvedValue({ accepted: true, page: { documents: [{ id: 1 }], total: 1, page: 1, pages: 1 } });
    show();
    expect(await screen.findByText(text.failed)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("the document being written", () => {
  const line = (key: string, direction: "IN" | "OUT", cartons: number): DraftLine => ({ key, articleSizeId: key, article: "SK6", size: key, color: "RED", direction, cartons, inStore: 5 });

  it("a re-added size replaces its line in place; totals add up by direction", () => {
    const merged = mergeLines([line("a", "IN", 2), line("b", "OUT", 1)], [line("a", "IN", 7), line("c", "IN", 3)]);
    expect(merged.map((l) => `${l.key}${l.cartons}`)).toEqual(["a7", "b1", "c3"]);
    expect(totalsOf(merged)).toEqual({ cartonsIn: 10, cartonsOut: 1 });
  });

  it("checks a quantity the way the main process does", () => {
    const row = { articleSizeId: "a", size: "7/10", color: "RED", inStore: 5, hasOpening: false };
    expect(entryProblem(row, "ADJUSTMENT", "OUT", "")).toBeNull();
    expect(entryProblem(row, "ADJUSTMENT", "OUT", "5")).toBeNull();
    expect(entryProblem(row, "ADJUSTMENT", "OUT", "6")).toBe(text.notEnough(5));
    expect(entryProblem(row, "ADJUSTMENT", "IN", "2.5")).not.toBeNull();
    expect(entryProblem(row, "ADJUSTMENT", "IN", "0")).not.toBeNull();
    expect(entryProblem({ ...row, hasOpening: true }, "OPENING", "IN", "3")).toBe(text.alreadyOpened);
  });
});
