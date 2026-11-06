import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RAW_MATERIAL_KIND } from "@erp/domain";
import { KindStockPage } from "./KindStockPage";
import { parseKindStockReply, quantityLabel } from "./kindStock";

// The two stock pages' four states, and that a reply is checked before it is believed (R12, R25).

const listKindStock = vi.fn();

const api = { listKindStock };
vi.mock("../../hooks/useDesktopApi", () => ({ useDesktopApi: () => api }));

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

    expect(await screen.findByRole("cell", { name: "UPPER — BLACK" })).toBeInTheDocument();
    expect(listKindStock).toHaveBeenCalledWith("UPPER", expect.anything());
    expect(screen.getByRole("heading", { level: 1, name: "Upper Stock" })).toBeInTheDocument();
    expect(screen.getAllByText("1,200 DOZEN")).toHaveLength(2);
  });

  it("shows a spinner first, and says so when the store has none", async () => {
    let answer: (value: unknown) => void = () => undefined;
    listKindStock.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    render(<KindStockPage kind={RAW_MATERIAL_KIND.DANA} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");

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
