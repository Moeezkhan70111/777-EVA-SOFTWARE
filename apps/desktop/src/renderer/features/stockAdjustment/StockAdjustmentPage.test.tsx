import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../../config/copy";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { StockAdjustmentPage } from "./StockAdjustmentPage";
import { coloursToAdd, entryGrid, entryProblem, gridEntries, mergeLines, totalsOf, typedCartons, type DraftLine } from "./stockAdjustmentDraft";

// STOCK ADJUSTMENT as an administrator meets it (docs/46): pick the article, then a box IN DOZENS for every colour and
// size at once (owner, 13 Nov 2026), each showing the figure now and what it would leave, the lines with totals, a Post
// that asks first. On a computer without the carton lease: read-only. Asserted in words (R18).

const text = copy.stockAdjustment;

const product = (article: string, size: string, colors: string[]) => ({
  id: `as-${article}-${size}`, articleSizeId: `as-${article}-${size}`, article, color: "", size, colors, description: null,
  costPrice: 300, sellingPrice: 550, mainGroupId: null, groupId: null, articleSeriesId: null, status: "ACTIVE", createdAt: "2024-01-01", updatedAt: "2024-01-01",
});
/** inStore is in cartons, as the main process answers; the screen shows dozens. */
const choice = (size: string, inStore: number, extra: { hasOpening?: boolean; colorMissing?: boolean; color?: string } = {}) => ({
  articleSizeId: `as-SK6-${size}`, size, color: extra.color ?? "RED", inStore, hasOpening: extra.hasOpening ?? false, colorMissing: extra.colorMissing ?? false,
});
const posted = {
  id: "d-1", code: "SA-000001", kind: "OPENING", businessDate: "2026-11-11", reason: "Opening count", remarks: null, postedBy: "owner",
  postedAt: "2026-11-11T05:00:00.000Z", cartonsIn: 94, cartonsOut: 0,
  lines: [{ lineNo: 1, article: "SK6", size: "10/13", color: "RED", direction: "IN", cartons: 70 }, { lineNo: 2, article: "SK6", size: "13/1", color: "RED", direction: "IN", cartons: 24 }],
};

let api: Record<string, ReturnType<typeof vi.fn>>;

const show = (canWrite = true, masterData = false) => {
  api.getWriteLeases.mockResolvedValue([
    { domain: "CARTON_STOCK", canWrite, reason: canWrite ? null : "HELD_ELSEWHERE", holderLabel: canWrite ? null : "PC 1 -- Manual Production" },
    { domain: "MASTER_DATA", canWrite: masterData, reason: masterData ? null : "HELD_ELSEWHERE", holderLabel: masterData ? null : "PC 1" },
  ]);
  render(<NotificationsProvider><StockAdjustmentPage /></NotificationsProvider>);
};

const pick = async (field: string, option: string) => {
  await userEvent.click(await screen.findByRole("combobox", { name: field }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
};
const postWithConfirm = async (label: string) => {
  await userEvent.click(screen.getByRole("button", { name: label }));
  const buttons = screen.getAllByRole("button", { name: label });
  await userEvent.click(buttons[buttons.length - 1]!);
};

beforeEach(() => {
  api = {
    getWriteLeases: vi.fn(),
    listProducts: vi.fn().mockResolvedValue({ rows: [product("SK6", "7/10", ["RED"]), product("SK6", "10/13", ["RED"]), product("SK6", "13/1", ["RED"])], total: 3, page: 1, pageSize: 1000 }),
    getCartonAdjustmentArticle: vi.fn().mockResolvedValue({ accepted: true, choices: [choice("10/13", 0), choice("7/10", 10, { hasOpening: true }), choice("13/1", 0)] }),
    listCartonStockAdjustments: vi.fn().mockResolvedValue({ accepted: true, page: { documents: [], total: 0, page: 1, pages: 1 } }),
    postCartonStockAdjustment: vi.fn().mockResolvedValue({ accepted: true, document: posted, duplicate: false }),
    addArticleColor: vi.fn().mockResolvedValue({ accepted: true, color: "SKY BLUE", added: 3, existing: 0 }),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

describe("Stock Adjustment", () => {
  const box = (color: string, size: string) => screen.getByRole("textbox", { name: text.quantityFor(color, size) });
  const twoColours = () => [
    choice("10/13", 0), choice("7/10", 10, { hasOpening: true }), choice("13/1", 0),
    choice("10/13", 0, { color: "BLUE" }), choice("7/10", 0, { color: "BLUE" }), choice("13/1", 0, { color: "BLUE" }),
  ];

  it("opening stock: the article's sizes down and colours across, every box typed at once, added in one go", async () => {
    api.getCartonAdjustmentArticle.mockResolvedValue({ accepted: true, choices: twoColours() });
    show();
    await pick(text.articleLabel, "SK6");
    const grid = await screen.findByRole("table");
    expect(within(grid).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["7/10", "10/13", "13/1"]);
    expect(within(grid).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([text.sizeColumn, "BLUE", "RED"]);
    // A size that already has opening stock says so and takes no box.
    expect(within(within(grid).getByRole("rowheader", { name: "7/10" }).closest("tr") as HTMLElement).getByText(text.hasOpening)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: text.quantityFor("RED", "7/10") })).toBeNull();

    await userEvent.type(box("RED", "10/13"), "35");
    await userEvent.type(box("BLUE", "13/1"), "12");
    await userEvent.type(box("BLUE", "7/10"), "3");
    expect(screen.getByText(text.typedSummary(3, "50"))).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: text.addToDocument }));

    const lines = screen.getByRole("region", { name: text.linesTitle });
    expect(within(lines).getByRole("row", { name: /^Total \+50 \/ −0 dozen/ })).toBeInTheDocument();
    expect((box("RED", "10/13") as HTMLInputElement).value).toBe("");
    await userEvent.type(screen.getByRole("textbox", { name: text.reasonLabel }), "Opening count");
    await postWithConfirm(text.post.OPENING);
    await waitFor(() => expect(api.postCartonStockAdjustment).toHaveBeenCalledTimes(1));
    const sent = api.postCartonStockAdjustment.mock.calls[0]?.[0] as { requestId: string; kind: string; lines: unknown[] };
    expect(sent.kind).toBe("OPENING");
    expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.lines).toEqual([
      { articleSizeId: "as-SK6-7/10", color: "BLUE", direction: "IN", cartons: 6 },
      { articleSizeId: "as-SK6-13/1", color: "BLUE", direction: "IN", cartons: 24 },
      { articleSizeId: "as-SK6-10/13", color: "RED", direction: "IN", cartons: 70 },
    ]);
    expect(await screen.findByText(text.posted("SA-000001", "47", "0"))).toBeInTheDocument();
  });

  it("Up and Down move along a colour; Enter adds every typed box", async () => {
    api.getCartonAdjustmentArticle.mockResolvedValue({ accepted: true, choices: twoColours() });
    show();
    await pick(text.articleLabel, "SK6");
    await userEvent.type(await screen.findByRole("textbox", { name: text.quantityFor("BLUE", "7/10") }), "2{ArrowDown}4{ArrowDown}6{ArrowUp}");
    expect(box("BLUE", "10/13")).toHaveFocus();
    expect((box("BLUE", "13/1") as HTMLInputElement).value).toBe("6");
    await userEvent.keyboard("{Enter}");
    const lines = screen.getByRole("region", { name: text.linesTitle });
    expect(await within(lines).findByRole("row", { name: /^Total \+12 \/ −0 dozen/ })).toBeInTheDocument();
  });

  it("a half dozen is one carton; a quarter dozen is refused", async () => {
    show();
    await pick(text.articleLabel, "SK6");
    await userEvent.type(await screen.findByRole("textbox", { name: text.quantityFor("RED", "13/1") }), "7.25");
    expect(screen.getByRole("alert")).toHaveTextContent(/whole or half dozens/);
    expect((screen.getByRole("button", { name: text.addToDocument }) as HTMLButtonElement).disabled).toBe(true);
  });

  // Owner, 12 Nov 2026: a decrease may take the store below zero; production is added later to balance it.
  it("a decrease larger than the store holds is allowed: the box shows the minus with a warning, and it can be added", async () => {
    show();
    await userEvent.click(await screen.findByRole("tab", { name: text.kinds.ADJUSTMENT }));
    await pick(text.articleLabel, "SK6");
    await userEvent.click(screen.getByRole("button", { name: text.directions.OUT }));
    await userEvent.type(await screen.findByRole("textbox", { name: text.quantityFor("RED", "7/10") }), "6");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(box("RED", "7/10").closest("td")).toHaveTextContent(`${text.cellNow("5")} → -1 ⚠`);
    await userEvent.click(screen.getByRole("button", { name: text.addToDocument }));
    const lines = screen.getByRole("region", { name: text.linesTitle });
    expect(await within(lines).findByText(`⚠ ${text.belowZero}`)).toBeInTheDocument();
  });

  it("a box where the colour is not on that size yet gets the colour added first, once per colour, then the lines", async () => {
    api.getCartonAdjustmentArticle.mockResolvedValue({ accepted: true, choices: [
      choice("7/10", 0), choice("10/13", 0, { colorMissing: true }), choice("13/1", 0, { colorMissing: true }),
      choice("7/10", 0, { color: "BLUE", colorMissing: true }), choice("10/13", 0, { color: "BLUE" }), choice("13/1", 0, { color: "BLUE" }),
    ] });
    show(true, true);
    await pick(text.articleLabel, "SK6");
    expect(within((await screen.findByRole("textbox", { name: text.quantityFor("RED", "10/13") })).closest("td") as HTMLElement).getByText(text.newOnSize)).toBeInTheDocument();
    await userEvent.type(box("RED", "10/13"), "4");
    await userEvent.type(box("RED", "13/1"), "1");
    await userEvent.type(box("BLUE", "7/10"), "2");
    await userEvent.click(screen.getByRole("button", { name: text.addToDocument }));
    await waitFor(() => expect(api.addArticleColor).toHaveBeenCalledTimes(2));
    expect(api.addArticleColor.mock.calls.map((call) => call[0])).toEqual([{ article: "SK6", color: "BLUE" }, { article: "SK6", color: "RED" }]);
    const lines = screen.getByRole("region", { name: text.linesTitle });
    expect(await within(lines).findByRole("row", { name: /^Total \+7 \/ −0 dozen/ })).toBeInTheDocument();
  });

  it("if a colour cannot be added, nothing goes on the document and the typing stays", async () => {
    api.getCartonAdjustmentArticle.mockResolvedValue({ accepted: true, choices: [choice("7/10", 0), choice("10/13", 0, { colorMissing: true })] });
    api.addArticleColor.mockResolvedValue({ accepted: false, reason: "Not now." });
    show(true, true);
    await pick(text.articleLabel, "SK6");
    await userEvent.type(await screen.findByRole("textbox", { name: text.quantityFor("RED", "10/13") }), "4");
    await userEvent.click(screen.getByRole("button", { name: text.addToDocument }));
    expect(await screen.findByText("⚠ Not now.")).toBeInTheDocument();
    expect((box("RED", "10/13") as HTMLInputElement).value).toBe("4");
    expect(within(screen.getByRole("region", { name: text.linesTitle })).queryByRole("row", { name: /^Total/ })).toBeNull();
  });

  it("where master data is written elsewhere, a box without the colour says so and takes no quantity", async () => {
    api.getCartonAdjustmentArticle.mockResolvedValue({ accepted: true, choices: [choice("7/10", 0), choice("10/13", 0, { colorMissing: true })] });
    show(true, false);
    await pick(text.articleLabel, "SK6");
    const grid = await screen.findByRole("table");
    expect(within(within(grid).getByRole("rowheader", { name: "10/13" }).closest("tr") as HTMLElement).getByText(text.colorNotOnSize)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: text.quantityFor("RED", "10/13") })).toBeNull();
    expect(screen.queryByRole("button", { name: text.addColorLabel("SK6") })).toBeNull();
  });

  it("+ New colour adds a colour to the article and it appears as a column, only where master data is written", async () => {
    show(true, true);
    await pick(text.articleLabel, "SK6");
    await userEvent.click(await screen.findByRole("button", { name: text.addColorLabel("SK6") }));
    api.getCartonAdjustmentArticle.mockResolvedValue({ accepted: true, choices: [choice("7/10", 0), choice("7/10", 0, { color: "SKY BLUE" }), choice("10/13", 0, { color: "SKY BLUE" })] });
    await userEvent.type(screen.getByRole("textbox", { name: text.newColorLabel }), "sky blue{Enter}");
    await waitFor(() => expect(api.addArticleColor).toHaveBeenCalledWith({ article: "SK6", color: "sky blue" }));
    expect(await screen.findByRole("textbox", { name: text.quantityFor("SKY BLUE", "10/13") })).toBeInTheDocument();
  });

  it("a lease refusal on Post is said in words and nothing is claimed posted", async () => {
    api.postCartonStockAdjustment.mockRejectedValue(new Error("Error invoking remote method 'erp:post-carton-stock-adjustment': LeaseError: Carton stock is written on PC 1 only. It is read-only here."));
    show();
    await pick(text.articleLabel, "SK6");
    await userEvent.type(await screen.findByRole("textbox", { name: text.quantityFor("RED", "13/1") }), "4");
    await userEvent.click(screen.getByRole("button", { name: text.addToDocument }));
    await userEvent.type(screen.getByRole("textbox", { name: text.reasonLabel }), "count");
    await postWithConfirm(text.post.OPENING);
    expect(await screen.findByText(/is read-only here/)).toBeInTheDocument();
    expect(screen.queryByText(text.postedTitle)).toBeNull();
  });

  it("on a computer without the carton lease: read-only notice, no form, the history still shows in dozens", async () => {
    api.listCartonStockAdjustments.mockResolvedValue({ accepted: true, page: { documents: [posted], total: 1, page: 1, pages: 1 } });
    show(false);
    expect(await screen.findByText(/written on PC 1 -- Manual Production only/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: text.articleLabel })).toBeNull();
    expect(await screen.findByText("SA-000001")).toBeInTheDocument();
    expect(screen.getByText("SK6 10/13 RED +35 · SK6 13/1 RED +12")).toBeInTheDocument();
  });

  it("shows a failure to read the history with a retry, never a blank list", async () => {
    api.listCartonStockAdjustments.mockResolvedValue({ accepted: true, page: { documents: [{ id: 1 }], total: 1, page: 1, pages: 1 } });
    show();
    expect(await screen.findByText(text.failed)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("the document being written", () => {
  const line = (key: string, direction: "IN" | "OUT", cartons: number): DraftLine => ({ key, articleSizeId: key, article: "SK6", size: key, color: "RED", direction, cartons, inStore: 10 });
  const row = { articleSizeId: "a", size: "7/10", color: "RED", inStore: 10, hasOpening: false, colorMissing: false };

  it("a re-added size replaces its line in place; totals add up by direction", () => {
    const merged = mergeLines([line("a", "IN", 2), line("b", "OUT", 1)], [line("a", "IN", 7), line("c", "IN", 3)]);
    expect(merged.map((l) => `${l.key}${l.cartons}`)).toEqual(["a7", "b1", "c3"]);
    expect(totalsOf(merged)).toEqual({ cartonsIn: 10, cartonsOut: 1 });
  });

  it("the grid: sizes in store order, colours A to Z; typed boxes make lines colour by colour; missing colours named once", () => {
    const choices = [
      { ...row, articleSizeId: "b", size: "10/13", color: "RED" }, { ...row, articleSizeId: "a", size: "7/10", color: "RED" },
      { ...row, articleSizeId: "a", size: "7/10", color: "BLUE", colorMissing: true }, { ...row, articleSizeId: "b", size: "10/13", color: "BLUE", colorMissing: true },
    ];
    const grid = entryGrid(choices);
    expect(grid.sizes.map((size) => size.size)).toEqual(["7/10", "10/13"]);
    expect(grid.colours).toEqual(["BLUE", "RED"]);
    const typed = { "b|RED": "2", "a|BLUE": "1.5", "b|BLUE": "1", "a|RED": " " };
    expect(gridEntries("SK6", choices, typed, "IN").map((line) => `${line.color} ${line.size} ${String(line.cartons)}`)).toEqual(["BLUE 7/10 3", "BLUE 10/13 2", "RED 10/13 4"]);
    expect(coloursToAdd(choices, typed)).toEqual(["BLUE"]);
  });

  it("dozens typed are whole cartons: 7.5 dozen is 15 cartons", () => {
    expect(typedCartons("7.5")).toBe(15);
    expect(typedCartons("10")).toBe(20);
    expect(typedCartons("7.25")).toBeNull();
    expect(typedCartons("")).toBeNull();
  });

  it("checks a quantity the way the main process does, in dozens", () => {
    expect(entryProblem(row, "ADJUSTMENT", "OUT", "", true)).toBeNull();
    expect(entryProblem(row, "ADJUSTMENT", "OUT", "5", true)).toBeNull();
    expect(entryProblem(row, "ADJUSTMENT", "OUT", "5.5", true)).toBeNull(); // below zero is allowed (owner, 12 Nov 2026)
    expect(entryProblem(row, "ADJUSTMENT", "IN", "2.25", true)).not.toBeNull();
    expect(entryProblem(row, "ADJUSTMENT", "IN", "0", true)).not.toBeNull();
    expect(entryProblem({ ...row, hasOpening: true }, "OPENING", "IN", "3", true)).toBe(text.alreadyOpened);
    expect(entryProblem({ ...row, colorMissing: true }, "OPENING", "IN", "3", false)).toBe(text.colorNotOnSize);
    expect(entryProblem({ ...row, colorMissing: true }, "OPENING", "IN", "3", true)).toBeNull();
  });
});
