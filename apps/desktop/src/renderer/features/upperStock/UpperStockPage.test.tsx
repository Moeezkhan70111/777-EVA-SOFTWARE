import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildUpperStockMatrix, type UpperStockMaterial } from "@erp/domain";
import { UpperStockPage } from "./UpperStockPage";
import { cellText, parseUpperStockReply } from "./upperStock";

// The page against the real matrix builder: the fake here stands in for the main process only.

const listUpperStockMatrix = vi.fn();

const api = { listUpperStockMatrix };
vi.mock("../../hooks/useDesktopApi", () => ({ useDesktopApi: () => api }));

const material = (article: string, size: string, colour: string, onHand: number, categoryName = "RUBBER UPPER", type: string | null = null): UpperStockMaterial => ({
  itemCode: `RM-${article}-${size}-${colour}`,
  displayName: `UPPER — ${categoryName} — ${article} — ${colour} — ${size}`,
  categoryName,
  article,
  size,
  colour,
  type,
  onHand,
  unitCode: "DOZEN",
});

const STOCK = [
  material("SK6", "7/10", "BLACK", 10),
  material("SK6", "7/10", "RED", 20),
  material("SK6", "4/6", "BLACK", 5),
  material("HR1", "7/10", "CREAM", 300, "RAGZINE UPPER"),
  material("DC1", "6/7", "BLACK", 12.5, "RUBBER UPPER", "L"),
  material("DC1", "6/7", "BLACK", 12.5, "RUBBER UPPER", "R"),
];

const serve = () =>
  listUpperStockMatrix.mockImplementation(async (query: Parameters<typeof buildUpperStockMatrix>[1]) => ({ accepted: true, ...buildUpperStockMatrix(STOCK, query) }));

const headings = () => screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
const matrix = (name: string) => within(screen.getByRole("region", { name: `${name} stock` }));

afterEach(() => listUpperStockMatrix.mockReset());

describe("UpperStockPage", () => {
  it("opens on All, one matrix per article, each under its name", async () => {
    serve();
    render(<UpperStockPage />);
    await screen.findByRole("region", { name: "SK6 stock" });
    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
    expect(headings()).toEqual(["DC1", "HR1", "SK6"]);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("works out the size totals and one grand total, with a dash for nothing and no row per colour", async () => {
    serve();
    render(<UpperStockPage />);
    await screen.findByRole("region", { name: "SK6 stock" });
    const table = matrix("SK6");
    expect(table.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Size", "BLACK", "RED", "Total"]);
    expect(table.getByRole("row", { name: "4/6 5 - 5" })).toBeInTheDocument();
    expect(table.getByRole("row", { name: "7/10 10 20 30" })).toBeInTheDocument();
    expect(table.getByRole("row", { name: "Total DOZEN 35" })).toBeInTheDocument();
    expect(table.getAllByRole("row")).toHaveLength(4);
  });

  it("shows L and R apart, never added into one cell", async () => {
    serve();
    render(<UpperStockPage />);
    await screen.findByRole("region", { name: "DC1 stock" });
    expect(matrix("DC1").getByRole("row", { name: /^6.7.?L 12.5 12.5$/ })).toBeInTheDocument();
    expect(matrix("DC1").getByRole("row", { name: /^6.7.?R 12.5 12.5$/ })).toBeInTheDocument();
  });

  it("filters by category at once", async () => {
    serve();
    render(<UpperStockPage />);
    await screen.findByRole("region", { name: "SK6 stock" });
    await userEvent.click(screen.getByRole("tab", { name: "Ragzine Upper" }));
    await waitFor(() => expect(headings()).toEqual(["HR1"]));
    expect(screen.getByRole("tab", { name: "Ragzine Upper" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "false");

    await userEvent.click(screen.getByRole("tab", { name: "Pasting Upper" }));
    expect(await screen.findByText("No uppers in the store yet")).toBeInTheDocument();
  });

  it("searches, and says when nothing matches", async () => {
    serve();
    render(<UpperStockPage />);
    await screen.findByRole("region", { name: "SK6 stock" });
    await userEvent.type(screen.getByRole("searchbox"), "sk6");
    await waitFor(() => expect(headings()).toEqual(["SK6"]));

    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.type(screen.getByRole("searchbox"), "velcro");
    expect(await screen.findByText("Nothing matches that search")).toBeInTheDocument();
  });

  it("sorts each of the four ways", async () => {
    serve();
    render(<UpperStockPage />);
    await screen.findByRole("region", { name: "SK6 stock" });
    const sort = screen.getByRole("combobox", { name: /sort by/i });
    expect(within(sort).getAllByRole("option").map((option) => option.textContent)).toEqual(["Item name (A–Z)", "Item name (Z–A)", "Highest stock first", "Lowest stock first"]);

    await userEvent.selectOptions(sort, "Item name (Z–A)");
    await waitFor(() => expect(headings()).toEqual(["SK6", "HR1", "DC1"]));
    await userEvent.selectOptions(sort, "Highest stock first");
    await waitFor(() => expect(headings()).toEqual(["HR1", "SK6", "DC1"]));
    await userEvent.selectOptions(sort, "Lowest stock first");
    await waitFor(() => expect(headings()).toEqual(["DC1", "SK6", "HR1"]));
  });

  it("heads each card with its kind and what it holds, and folds the table away", async () => {
    serve();
    render(<UpperStockPage />);
    await screen.findByRole("region", { name: "SK6 stock" });
    const card = within(screen.getByRole("region", { name: "SK6" }));
    expect(card.getByText("Rubber Upper")).toBeInTheDocument();
    expect(card.getByText("35 Dozen")).toBeInTheDocument();

    const fold = card.getByRole("button", { name: "Show or hide SK6" });
    expect(fold).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "SK6 stock" })).not.toBeInTheDocument();
    expect(card.getByText("35 Dozen")).toBeInTheDocument();
    // Only this article folded.
    expect(screen.getByRole("region", { name: "HR1 stock" })).toBeInTheDocument();

    await userEvent.click(fold);
    expect(screen.getByRole("region", { name: "SK6 stock" })).toBeInTheDocument();
  });

  it("offers no grid or list toggle", async () => {
    serve();
    render(<UpperStockPage />);
    await screen.findByRole("region", { name: "SK6 stock" });
    expect(screen.queryByRole("button", { name: /grid|list view/i })).not.toBeInTheDocument();
  });

  it("shows a refusal as a failure, not as an empty store", async () => {
    listUpperStockMatrix.mockResolvedValue({ accepted: false, reason: "You do not have permission to perform this action." });
    render(<UpperStockPage />);
    expect(await screen.findByText("You do not have permission to perform this action.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("parseUpperStockReply", () => {
  const good = { accepted: true, ...buildUpperStockMatrix(STOCK) };

  it("does not believe a malformed reply", () => {
    const article = good.articles[0];
    const row = article?.rows[0];
    for (const bad of [
      null,
      {},
      { ...good, articles: "none" },
      { ...good, articleCount: "6" },
      { ...good, articles: [{ ...article, total: "9" }] },
      { ...good, articles: [{ ...article, rows: [{ ...row, quantities: [1, 2, 3, 4, 5] }] }] },
    ]) {
      expect(parseUpperStockReply(bad).ok).toBe(false);
    }
    expect(parseUpperStockReply(good).ok).toBe(true);
  });
});

describe("cellText", () => {
  it("prints nothing as a dash, and thousands separated", () => {
    expect(cellText(0)).toBe("-");
    expect(cellText(1234.5)).toBe("1,234.5");
  });
});
