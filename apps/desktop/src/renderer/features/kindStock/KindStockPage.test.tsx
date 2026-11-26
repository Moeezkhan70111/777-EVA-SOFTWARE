import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RAW_MATERIAL_KIND } from "@erp/domain";
import { KindStockPage } from "./KindStockPage";
import { parseKindStockReply, quantityLabel } from "./kindStock";

// The two stock pages' four states, and that a reply is checked before it is believed (R12, R25).

const listKindStock = vi.fn();

const listKindStockSheet = vi.fn();
const openPrintDocumentAsync = vi.fn((html: Promise<string>) => { void html; return true; });
const api = { listKindStock, listKindStockSheet };
vi.mock("../../hooks/useDesktopApi", () => ({ useDesktopApi: () => api }));
vi.mock("../../platform/print", () => ({ openPrintDocumentAsync: (html: Promise<string>) => openPrintDocumentAsync(html), loadLogoDataUrl: async () => "", urduFontFaceCss: () => "" }));

const reply = (overrides: Record<string, unknown> = {}) => ({
  accepted: true,
  items: [{ id: "i-1", code: "RM-000001", name: "UPPER — BLACK", subCategory: "RUBBER UPPER", quantity: 1200, unitCode: "DOZEN" }],
  itemCount: 1,
  totalsByUnit: [{ unitId: "u-1", unitCode: "DOZEN", quantity: 1200 }],
  page: 1,
  pages: 1,
  ...overrides,
});

afterEach(() => listKindStock.mockReset());

describe("KindStockPage", () => {
  it("asks for its own kind, and shows the balance and the totals", async () => {
    listKindStock.mockResolvedValue(reply());
    render(<KindStockPage kind={RAW_MATERIAL_KIND.UPPER} />);

    expect(await screen.findByText("UPPER — BLACK")).toBeInTheDocument();
    expect(screen.getByText("RM-000001")).toBeInTheDocument();
    expect(listKindStock).toHaveBeenCalledWith("UPPER", expect.anything());
    expect(screen.getByRole("heading", { level: 1, name: "Upper Stock" })).toBeInTheDocument();
    expect(screen.getAllByText("1,200 DOZEN")).toHaveLength(2);
  });

  it("shows the table's outline first, and says so when the store has none", async () => {
    let answer: (value: unknown) => void = () => undefined;
    listKindStock.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    render(<KindStockPage kind={RAW_MATERIAL_KIND.DANA} />);
    expect(screen.getByRole("status").closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");

    answer(reply({ items: [], itemCount: 0, totalsByUnit: [] }));
    expect(await screen.findByText("No dana in the store yet")).toBeInTheDocument();
  });

  it("shows a refusal as a failure with a retry, not as an empty store", async () => {
    listKindStock.mockResolvedValueOnce({ accepted: false, reason: "You do not have permission to perform this action." });
    render(<KindStockPage kind={RAW_MATERIAL_KIND.DANA} />);
    expect(await screen.findByText("You do not have permission to perform this action.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    listKindStock.mockResolvedValue(reply());
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("sends the search to the data layer, and says when nothing matches", async () => {
    listKindStock.mockResolvedValue(reply());
    render(<KindStockPage kind={RAW_MATERIAL_KIND.UPPER} />);
    await screen.findByRole("table");

    listKindStock.mockResolvedValue(reply({ items: [], itemCount: 0, totalsByUnit: [] }));
    await userEvent.type(screen.getByRole("searchbox"), "pink");
    await waitFor(() => expect(listKindStock).toHaveBeenLastCalledWith("UPPER", { search: "pink", page: 1 }));
    expect(await screen.findByText("Nothing matches that search")).toBeInTheDocument();
  });
});

describe("parseKindStockReply", () => {
  it("says Empty in words when nothing is in store, never a bare zero", async () => {
    listKindStock.mockResolvedValue(reply({ items: [{ id: "i-2", code: "RM-000002", name: "EVA — RED", subCategory: "EVA", quantity: 0, unitCode: "KG" }] }));
    render(<KindStockPage kind={RAW_MATERIAL_KIND.DANA} />);
    expect(await screen.findByText("Empty")).toHaveClass("badge");
  });

  it("does not believe a malformed reply", () => {
    for (const bad of [null, "yes", {}, reply({ items: "none" }), reply({ items: [{ id: 1 }] }), reply({ itemCount: "1" }), reply({ totalsByUnit: [{ quantity: "9" }] })]) {
      expect(parseKindStockReply(bad).ok).toBe(false);
    }
    expect(parseKindStockReply(reply()).ok).toBe(true);
  });

  it("carries a refusal's reason", () => {
    expect(parseKindStockReply({ accepted: false, reason: "No." })).toEqual({ ok: false, reason: "No." });
  });
});

describe("quantityLabel", () => {
  it("keeps the unit, and drops a trailing nothing", () => {
    expect(quantityLabel(1200.5, "KG")).toBe("1,200.5 KG");
    expect(quantityLabel(0, "")).toBe("0");
  });
});

describe("the Dana Stock Sheet", () => {
  it("prints the whole store from Dana Stock, read at the moment of printing", async () => {
    listKindStock.mockResolvedValue(reply());
    listKindStockSheet.mockResolvedValue({ accepted: true, kind: "DANA", rows: [{ id: "d", path: ["SPECIAL", "EVA"], colour: "BLACK", colourUrdu: "", size: "1.65", quantity: 40, unitCode: "BAG" }] });
    render(<KindStockPage kind={RAW_MATERIAL_KIND.DANA} />);
    await userEvent.click(screen.getByRole("button", { name: "Print stock sheet" }));
    expect(listKindStockSheet).toHaveBeenCalledWith("DANA");
    const html = await openPrintDocumentAsync.mock.calls[0]?.[0];
    expect(html).toContain("DANA STOCK SHEET");
    expect(html).toContain(">40<");
  });

  it("is not offered on Upper Stock", async () => {
    listKindStock.mockResolvedValue(reply());
    render(<KindStockPage kind={RAW_MATERIAL_KIND.UPPER} />);
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: "Print stock sheet" })).not.toBeInTheDocument();
  });
});
