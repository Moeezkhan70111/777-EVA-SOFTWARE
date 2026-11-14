import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COLOR_TRANSLATIONS, buildCartonStockMatrix, type CartonStockFigure } from "@erp/domain";
import { copy } from "../../config/copy";
import { toIsoDate } from "../../utils/dates";
import { publishColorTranslations } from "../colorTranslation/colorDictionaryStore";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { CartonStockPage } from "./CartonStockPage";

// CARTON STOCK (shown in dozens: 1 carton = half a dozen): the cartons in store, one matrix per article. The main process reads every figure;
// the screen arranges nothing of its own and changes nothing.

const text = copy.cartonStock;

const api = { getCartonStockMatrix: vi.fn(), getProductionDayMark: vi.fn() };

/** The store figures the matrix is built from, as the main process would read them. */
let figures: CartonStockFigure[] = [];

const show = () => render(<NotificationsProvider><CartonStockPage /></NotificationsProvider>);
const matrix = (article: string) => within(screen.getByRole("region", { name: `${article} cartons in store` }));
// Read straight from the page: role queries over dozens of tables are too slow for jsdom.
const names = () => Array.from(document.querySelectorAll("h2"), (heading) => heading.textContent);

/** Opens the article series picker and picks one (the shared searchable picker, as a panel). */
const pickSeries = async (label: string) => {
  await userEvent.click(screen.getByRole("combobox", { name: text.seriesLabel }));
  await userEvent.click(screen.getByRole("option", { name: new RegExp(`^${label}`) }));
};

const seededList = () => DEFAULT_COLOR_TRANSLATIONS.map((row, index) => ({ id: `c-${String(index)}`, englishName: row.english, urduName: row.urdu }));

beforeEach(() => {
  publishColorTranslations(seededList());
  figures = [
    { article: "SK6", size: "7/10", color: "RED", series: "SKECHERS", quantity: 2 }, { article: "SK6", size: "7/10", color: "BLUE", series: "SKECHERS", quantity: 6 },
    { article: "SK6", size: "4/6", color: "RED", series: "SKECHERS", quantity: 5 }, { article: "SK12", size: "7/10", color: "MUSTARD", series: "SKECHERS", quantity: 6 },
    { article: "SK30", size: "4/6", color: "RED", series: "DOUBLE COLOR", quantity: 3 },
  ];
  api.getCartonStockMatrix.mockReset().mockImplementation(async (query: { search: string; series: string; shown: number }) => ({ accepted: true, ...buildCartonStockMatrix(figures, { search: query.search, series: query.series, pageSize: query.shown }) }));
  api.getProductionDayMark.mockReset().mockResolvedValue({ accepted: true, mark: null });
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

// Owner, 14 Nov 2026: a box that stays grey, "Production not added", until someone completes today's production on the
// Manual Production page; then green, "Production added". It asks for today, and follows carton changes from sync.
describe("today's production box", () => {
  const status = copy.productionDay;
  const MARK = { date: "2026-11-14", completedAt: "2026-11-14T13:05:00.000Z", completedBy: "aslam", cartons: 22, entries: 2 };
  const box = () => document.querySelector(".pd-status");

  it("is grey and says Production not added until the day is completed, for today", async () => {
    show();
    expect(await screen.findByText(status.notAdded)).toBeInTheDocument();
    expect(box()).toHaveClass("is-pending");
    expect(box()).toHaveTextContent("○");
    expect(api.getProductionDayMark).toHaveBeenCalledWith({ date: toIsoDate() });
  });

  it("turns green and says Production added, with when and by whom, once the day is completed", async () => {
    api.getProductionDayMark.mockResolvedValue({ accepted: true, mark: MARK });
    show();
    expect(await screen.findByText(status.added)).toBeInTheDocument();
    expect(box()).toHaveClass("is-added");
    expect(box()).toHaveTextContent("✓");
    expect(box()).toHaveTextContent(status.addedBy("6:05 PM", "aslam"));
  });

  it("never says added when the answer cannot be trusted: it says the status could not be read", async () => {
    api.getProductionDayMark.mockResolvedValue({ accepted: true, mark: { date: "2026-11-14", completedBy: 7 } });
    show();
    expect(await screen.findByText(status.unknown)).toBeInTheDocument();
    expect(screen.queryByText(status.added)).toBeNull();
  });
});

describe("the stock matrix", () => {
  it("shows one card per article, Size down the side, its colours across, a Total per size, and a Total row with each colour and the grand total", async () => {
    show();
    await screen.findByRole("region", { name: "SK6 cartons in store" });
    expect(names()).toEqual(["SK6", "SK12", "SK30"]);
    // Colours are named in Urdu from the shared colour list (docs/45); the order is still the English one.
    expect(matrix("SK6").getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Size (dozen)", "بلو", "لال", "Total"]);
    expect(matrix("SK6").getByRole("row", { name: "7/10 3 1 4" })).toBeInTheDocument();
    expect(matrix("SK6").getByRole("row", { name: "4/6 - 2.5 2.5" })).toBeInTheDocument();
    expect(matrix("SK6").getByRole("row", { name: "Total 3 3.5 6.5" })).toBeInTheDocument();
    expect(matrix("SK6").getAllByRole("row")).toHaveLength(4);
  });

  it("a card at the top gives the total carton stock in dozens, and follows the search", async () => {
    show();
    const card = () => document.querySelector(".cs-summary");
    await waitFor(() => expect(card()).toHaveTextContent(`${text.totalCardLabel}11${text.totalCardSub(3, "22", false)}`));
    await userEvent.type(screen.getByRole("searchbox", { name: text.searchLabel }), "sk6");
    await waitFor(() => expect(card()).toHaveTextContent(`${text.totalCardLabel}6.5${text.totalCardSub(1, "13", true)}`));
  });

  it("narrows by search and by article series, and offers no article or colour picker", async () => {
    show();
    await screen.findByRole("region", { name: "SK6 cartons in store" });
    await userEvent.type(screen.getByRole("searchbox", { name: text.searchLabel }), "sk3");
    await waitFor(() => expect(names()).toEqual(["SK30"]));
    await userEvent.clear(screen.getByRole("searchbox", { name: text.searchLabel }));
    await waitFor(() => expect(names()).toEqual(["SK6", "SK12", "SK30"]));

    // Each series says how many articles it has and what they hold; All is the whole store, whatever the search.
    await userEvent.click(screen.getByRole("combobox", { name: text.seriesLabel }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      `${text.allSeries}${text.seriesDozens("11")}${text.seriesArticles(3)}`,
      `DOUBLE COLOR${text.seriesDozens("1.5")}${text.seriesArticles(1)}`,
      `SKECHERS${text.seriesDozens("9.5")}${text.seriesArticles(2)}`,
    ]);
    await userEvent.click(screen.getByRole("option", { name: /^DOUBLE COLOR/ }));
    await waitFor(() => expect(names()).toEqual(["SK30"]));
    await pickSeries("SKECHERS");
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

// Many colours scroll sideways, and the card says so: a strip above the table names how many colours there are,
// with arrow buttons that scroll it, each disabled at its end. jsdom lays nothing out, so the test says how wide
// the table and its box are.
describe("an article with more colours than fit across", () => {
  const COLOURS = ["RED", "BLUE", "GREEN", "BROWN", "SKIN", "PINK", "BLACK", "WHITE", "GREY", "NAVY", "MUSTARD", "ORANGE", "PURPLE", "CREAM"];
  const scrolled = new WeakMap<Element, number>();
  const scrollBy = vi.fn();

  beforeEach(() => {
    figures = COLOURS.map((color, index) => ({ article: "SK6", size: "7/10", color, series: "SKECHERS", quantity: (index + 1) * 2 }));
    const isBox = (element: Element) => element.classList.contains("sideways-scroll");
    const restore = [
      ["scrollWidth", { get(this: Element) { return isBox(this) ? 1600 : 0; } }],
      ["clientWidth", { get(this: Element) { return isBox(this) ? 800 : 0; } }],
      ["scrollLeft", { get(this: Element) { return scrolled.get(this) ?? 0; }, set(this: Element, value: number) { scrolled.set(this, value); } }],
    ].map(([name, descriptor]) => {
      const before = Object.getOwnPropertyDescriptor(Element.prototype, name as string);
      Object.defineProperty(Element.prototype, name as string, { configurable: true, ...(descriptor as PropertyDescriptor) });
      return () => (before ? Object.defineProperty(Element.prototype, name as string, before) : undefined);
    });
    scrollBy.mockReset();
    Object.defineProperty(Element.prototype, "scrollBy", { configurable: true, value: scrollBy });
    return () => restore.forEach((undo) => undo());
  });

  it("keeps every colour in one table, and says plainly to scroll sideways", async () => {
    show();
    await screen.findByText(copy.sidewaysScroll.hint(14));
    const table = matrix("SK6").getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(16);
    // Every figure once: 2+4+…+28 cartons = 210 cartons = 105 dozen, in the one Total.
    expect(within(table).getByRole("row", { name: /^7\/10 .* 105$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.sidewaysScroll.left })).toBeDisabled();
    expect(screen.getByRole("button", { name: copy.sidewaysScroll.right })).toBeEnabled();
  });

  it("scrolls when an arrow is pressed, and turns the arrow off at the end", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: copy.sidewaysScroll.right }));
    expect(scrollBy).toHaveBeenCalledWith({ left: 640, behavior: "smooth" });
    const box = screen.getByRole("region", { name: "SK6 cartons in store" });
    act(() => {
      box.scrollLeft = 800;
      box.dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByRole("button", { name: copy.sidewaysScroll.right })).toBeDisabled();
    expect(screen.getByRole("button", { name: copy.sidewaysScroll.left })).toBeEnabled();
  });
});

it("shows no scroll strip when every colour fits", async () => {
  show();
  await screen.findByRole("region", { name: "SK6 cartons in store" });
  expect(screen.queryByText(/scroll sideways/)).not.toBeInTheDocument();
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
    await pickSeries("SKECHERS");
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
    // The matrix, and today's production status box (useTodayMark): both follow carton changes.
    expect(listeners.size).toBe(2);
    page.unmount();
    expect(listeners.size).toBe(0);
  });
});
