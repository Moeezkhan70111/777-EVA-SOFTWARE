import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COLOR_TRANSLATIONS, buildCartonStockMatrix, type CartonStockFigure } from "@erp/domain";
import { copy } from "../../config/copy";
import { publishColorTranslations } from "../colorTranslation/colorDictionaryStore";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { CartonStockPage } from "./CartonStockPage";

// CARTON STOCK (shown in dozens: 1 carton = half a dozen): the cartons in store, one matrix per article. The main process reads every figure;
// the screen arranges nothing of its own and changes nothing.

const text = copy.cartonStock;

const api = { getCartonStockMatrix: vi.fn() };

/** The store figures the matrix is built from, as the main process would read them. */
let figures: CartonStockFigure[] = [];

const show = () => render(<NotificationsProvider><CartonStockPage /></NotificationsProvider>);
const matrix = (article: string) => within(screen.getByRole("region", { name: `${article} cartons in store` }));
// Read straight from the page: role queries over dozens of tables are too slow for jsdom.
const names = () => Array.from(document.querySelectorAll("h2"), (heading) => heading.textContent);

const seededList = () => DEFAULT_COLOR_TRANSLATIONS.map((row, index) => ({ id: `c-${String(index)}`, englishName: row.english, urduName: row.urdu }));

beforeEach(() => {
  publishColorTranslations(seededList());
  figures = [
    { article: "SK6", size: "7/10", color: "RED", series: "SKECHERS", quantity: 2 }, { article: "SK6", size: "7/10", color: "BLUE", series: "SKECHERS", quantity: 6 },
    { article: "SK6", size: "4/6", color: "RED", series: "SKECHERS", quantity: 5 }, { article: "SK12", size: "7/10", color: "MUSTARD", series: "SKECHERS", quantity: 6 },
    { article: "SK30", size: "4/6", color: "RED", series: "DOUBLE COLOR", quantity: 3 },
  ];
  api.getCartonStockMatrix.mockReset().mockImplementation(async (query: { search: string; series: string; shown: number }) => ({ accepted: true, ...buildCartonStockMatrix(figures, { search: query.search, series: query.series, pageSize: query.shown }) }));
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

describe("the stock matrix", () => {
  it("shows one card per article, Size down the side, its colours across, a Total per size and no grand total", async () => {
    show();
    await screen.findByRole("region", { name: "SK6 cartons in store" });
    expect(names()).toEqual(["SK6", "SK12", "SK30"]);
    // Colours are named in Urdu from the shared colour list (docs/45); the order is still the English one.
    expect(matrix("SK6").getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Size (dozen)", "بلو", "لال", "Total"]);
    expect(matrix("SK6").getByRole("row", { name: "7/10 3 1 4" })).toBeInTheDocument();
    expect(matrix("SK6").getByRole("row", { name: "4/6 - 2.5 2.5" })).toBeInTheDocument();
    expect(matrix("SK6").getAllByRole("row")).toHaveLength(3);
  });

  it("narrows by search and by article series, and offers no article or colour picker", async () => {
    show();
    await screen.findByRole("region", { name: "SK6 cartons in store" });
    await userEvent.type(screen.getByRole("searchbox", { name: text.searchLabel }), "sk3");
    await waitFor(() => expect(names()).toEqual(["SK30"]));
    await userEvent.clear(screen.getByRole("searchbox", { name: text.searchLabel }));
    await waitFor(() => expect(names()).toEqual(["SK6", "SK12", "SK30"]));

    const series = screen.getByRole("combobox", { name: text.seriesLabel });
    expect(within(series).getAllByRole("option").map((option) => option.textContent)).toEqual([text.allSeries, "DOUBLE COLOR", "SKECHERS"]);
    await userEvent.selectOptions(series, "DOUBLE COLOR");
    await waitFor(() => expect(names()).toEqual(["SK30"]));
    await userEvent.selectOptions(series, "SKECHERS");
    await waitFor(() => expect(names()).toEqual(["SK6", "SK12"]));
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
  });

  it("says when there is no carton stock, and shows a refusal as a failure", async () => {
    figures = [];
    const { unmount } = show();
    expect(await screen.findByText(text.emptyTitle)).toBeInTheDocument();
    unmount();
    api.getCartonStockMatrix.mockReset().mockResolvedValue({ accepted: false, reason: "Administrator access required" });
    show();
    expect(await screen.findByText("Administrator access required")).toBeInTheDocument();
  });

  it("names colours in Urdu from the colour list, falls back to the stored English, and follows the list as it changes", async () => {
    figures = [
      { article: "SK6", size: "7/10", color: "BLACKRED", series: "SKECHERS", quantity: 2 },
      { article: "SK6", size: "7/10", color: "MITALIC", series: "SKECHERS", quantity: 1 },
      { article: "SK6", size: "7/10", color: "ARMY GREEN", series: "SKECHERS", quantity: 4 },
    ];
    show();
    await screen.findByRole("region", { name: "SK6 cartons in store" });
    expect(matrix("SK6").getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Size (dozen)", "آرمی گرین", "سیاہ لال", "MITALIC", "Total"]);
    expect(matrix("SK6").getByRole("columnheader", { name: "MITALIC" })).toHaveAttribute("title", "MITALIC");
    expect(matrix("SK6").getByRole("row", { name: "7/10 2 1 0.5 3.5" })).toBeInTheDocument();

    act(() => publishColorTranslations([...seededList(), { id: "c-mitalic", englishName: "Mitalic", urduName: "میٹالک" }]));
    expect(await matrix("SK6").findByRole("columnheader", { name: "میٹالک" })).toBeInTheDocument();
    // The figures, and what was asked of the main process, are unchanged: only the label is translated.
    expect(matrix("SK6").getByRole("row", { name: "7/10 2 1 0.5 3.5" })).toBeInTheDocument();
    for (const [query] of api.getCartonStockMatrix.mock.calls as Array<[Record<string, unknown>]>) expect(JSON.stringify(query)).not.toMatch(/[؀-ۿ]/);
  });

  it("offers no adjustment and no check: the page only shows stock", async () => {
    show();
    await screen.findByRole("region", { name: "SK6 cartons in store" });
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
  });
});

// Many colours never scroll sideways: they continue in bands underneath, each with the sizes, and
// the Total on the last. ResizeObserver stands in for the window, saying how wide the list is.
describe("an article with more colours than fit across", () => {
  const COLOURS = ["RED", "BLUE", "GREEN", "BROWN", "SKIN", "PINK", "BLACK", "WHITE", "GREY", "NAVY", "MUSTARD", "ORANGE", "PURPLE", "CREAM"];

  beforeEach(() => {
    figures = COLOURS.map((color, index) => ({ article: "SK6", size: "7/10", color, series: "SKECHERS", quantity: (index + 1) * 2 }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        // 1100px wide: 7 colours fit across, so 14 make two bands of 7.
        observe(target: Element) { this.callback([{ target, contentRect: { width: 1100 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
        unobserve() {}
        disconnect() {}
      }
    );
    return () => vi.unstubAllGlobals();
  });

  it("shows every colour in two bands of seven, sizes on both, the Total once at the end", async () => {
    show();
    await screen.findByText("Colors 8–14 of 14");
    const tables = matrix("SK6").getAllByRole("table");
    expect(tables).toHaveLength(2);
    expect(within(tables[0] as HTMLElement).getByText("Colors 1–7 of 14")).toBeInTheDocument();
    const heads = tables.map((table) => within(table).getAllByRole("columnheader").map((cell) => cell.getAttribute("title") ?? cell.textContent));
    expect(heads[0]).toEqual(["Size (dozen)", "BLACK", "BLUE", "BROWN", "CREAM", "GREEN", "GREY", "MUSTARD"]);
    expect(heads[1]).toEqual(["Size (dozen)", "NAVY", "ORANGE", "PINK", "PURPLE", "RED", "SKIN", "WHITE", "Total"]);
    // Every figure once: 2+4+…+28 cartons = 210 cartons = 105 dozen, on the last band's Total.
    expect(within(tables[1] as HTMLElement).getByRole("row", { name: /^7\/10 .* 105$/ })).toBeInTheDocument();
    expect(within(tables[0] as HTMLElement).queryByText("Total")).not.toBeInTheDocument();
  });
});

// The list has no pages: it shows 20 articles, and 20 more each time its end scrolls near. jsdom has
// no IntersectionObserver, so these tests stand one in and say when the end comes into view.
describe("loading as the list scrolls", () => {
  let watchers: Array<{ callback: IntersectionObserverCallback; watching: boolean }> = [];
  const endComesIntoView = () =>
    act(() => {
      for (const watcher of watchers.filter((w) => w.watching)) watcher.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

  beforeEach(() => {
    watchers = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private readonly watcher: { callback: IntersectionObserverCallback; watching: boolean };
        constructor(callback: IntersectionObserverCallback) {
          this.watcher = { callback, watching: false };
          watchers.push(this.watcher);
        }
        observe() { this.watcher.watching = true; }
        disconnect() { this.watcher.watching = false; }
        unobserve() { this.watcher.watching = false; }
        takeRecords() { return []; }
      }
    );
    figures = Array.from({ length: 45 }, (_, index) => ({ article: `SK${String(index + 1)}`, size: "7/10", color: "RED", series: "SKECHERS", quantity: 2 }));
    return () => vi.unstubAllGlobals();
  });

  it("shows a skeleton of the whole page until the first figures arrive", async () => {
    let answer: (reply: unknown) => void = () => undefined;
    api.getCartonStockMatrix.mockReset().mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    show();
    expect(screen.getByRole("status", { name: text.loading })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    await act(async () => answer({ accepted: true, ...buildCartonStockMatrix(figures, { pageSize: 20 }) }));
    expect(await screen.findByRole("searchbox", { name: text.searchLabel })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: text.loading })).not.toBeInTheDocument();
  });

  it("shows 20 articles, then 20 more each time the end scrolls near, and stops at the last", async () => {
    show();
    await screen.findByText("SK20", { selector: "h2" }, { timeout: 4000 });
    expect(names()).toHaveLength(20);
    expect(api.getCartonStockMatrix).toHaveBeenLastCalledWith({ search: "", series: "", shown: 20 });

    endComesIntoView();
    await screen.findByText("SK40", { selector: "h2" }, { timeout: 4000 });
    expect(names()).toHaveLength(40);
    expect(api.getCartonStockMatrix).toHaveBeenLastCalledWith({ search: "", series: "", shown: 40 });

    endComesIntoView();
    await screen.findByText("SK45", { selector: "h2" }, { timeout: 4000 });
    expect(names()).toHaveLength(45);
    const reads = api.getCartonStockMatrix.mock.calls.length;
    endComesIntoView();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.getCartonStockMatrix.mock.calls.length).toBe(reads);
  });

  it("shows skeleton cards below the list while the next articles load", async () => {
    show();
    await screen.findByText("SK20", { selector: "h2" }, { timeout: 4000 });
    let answer: (reply: unknown) => void = () => undefined;
    api.getCartonStockMatrix.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    endComesIntoView();
    expect(await screen.findByRole("status", { name: text.loadingMore })).toBeInTheDocument();
    expect(names()).toHaveLength(20);
    await act(async () => answer({ accepted: true, ...buildCartonStockMatrix(figures, { pageSize: 40 }) }));
    expect(screen.queryByRole("status", { name: text.loadingMore })).not.toBeInTheDocument();
    expect(names()).toHaveLength(40);
  });

  it("a new search or series starts again from the first 20", async () => {
    show();
    await screen.findByText("SK20", { selector: "h2" }, { timeout: 4000 });
    endComesIntoView();
    await screen.findByText("SK40", { selector: "h2" }, { timeout: 4000 });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: text.seriesLabel }), "SKECHERS");
    await waitFor(() => expect(api.getCartonStockMatrix).toHaveBeenLastCalledWith({ search: "", series: "SKECHERS", shown: 20 }));
    await waitFor(() => expect(names()).toHaveLength(20));
  });
});

// Another computer's production, gatepass or adjustment arrives through sync, which announces CARTONS
// (shared/dataChange.ts). The open page re-reads the main process's figures; it never adds anything.
describe("live updates from other computers, with the page open", () => {
  const installLiveBridge = () => {
    const listeners = new Set<(change: unknown) => void>();
    const onDataChanged = vi.fn((listener: (change: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    Object.defineProperty(window, "desktop", {
      value: { versions: { node: "22", chrome: "128", electron: "43" }, api: { ...api, onDataChanged } },
      configurable: true,
    });
    const announce = (kinds: string[]) => act(() => listeners.forEach((listener) => listener({ kinds })));
    return { announce, listeners };
  };

  it("re-reads on a carton change and shows the new figure", async () => {
    const { announce } = installLiveBridge();
    show();
    await screen.findByRole("row", { name: "7/10 3 1 4" });
    figures = figures.map((figure) => (figure.article === "SK6" && figure.color === "RED" && figure.size === "7/10" ? { ...figure, quantity: 12 } : figure));
    announce(["CARTONS", "SYNC"]);
    expect(await screen.findByRole("row", { name: "7/10 3 6 9" })).toBeInTheDocument();
  });

  it("ignores changes that are not cartons or products", async () => {
    const { announce } = installLiveBridge();
    show();
    await screen.findByRole("row", { name: "7/10 3 1 4" });
    const readsBefore = api.getCartonStockMatrix.mock.calls.length;
    announce(["CASH", "PARTIES"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.getCartonStockMatrix.mock.calls.length).toBe(readsBefore);
  });

  it("leaving the page lets go of its subscription", async () => {
    const { listeners } = installLiveBridge();
    const page = show();
    await screen.findByRole("row", { name: "7/10 3 1 4" });
    expect(listeners.size).toBe(1);
    page.unmount();
    expect(listeners.size).toBe(0);
  });
});
