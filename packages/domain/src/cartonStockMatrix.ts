// The Carton Stock page's matrix: each article as Size down the side and Colour across the top, with
// a Total per size, narrowed by a search and by article series. The figures are the store figure the other screens read (cartons in store,
// cartonStockReconciliation's storeFigure); this only arranges them. There is no grand total and no
// total per colour, by the owner's design.
//
//   COLUMNS ARE THE ARTICLE'S OWN COLOURS, so no stock is left off the page.
//   SIZES FOLLOW THE STORE'S ORDER (compareSizes), the same as Upper Stock.
//   A NEGATIVE FIGURE IS SHOWN AS IT IS. It means a movement the figure does not explain; hiding it
//   would hide that.

import { attributeKey, roundQuantity } from "./machineProgram.js";
import { compareSizes } from "./upperStockMatrix.js";

/** One product's figure: what the matrix reads. */
export interface CartonStockFigure {
  article: string;
  size: string;
  color: string;
  /** The product's article series (Product Master), or "" when it has none. */
  series: string;
  quantity: number;
}

export interface CartonMatrixRow {
  key: string;
  size: string;
  /** One per colour of the article, in the same order. 0 is shown as a dash. */
  quantities: number[];
  total: number;
}

export interface CartonMatrixArticle {
  key: string;
  article: string;
  colours: string[];
  rows: CartonMatrixRow[];
}

export interface CartonStockMatrix {
  articles: CartonMatrixArticle[];
  /** Matching articles across every page. */
  articleCount: number;
  page: number;
  pages: number;
  /** Every article series with stock, for the picker: not narrowed by the search. */
  seriesOptions: string[];
}

export interface CartonStockQuery {
  search?: string;
  /** One article series only. Blank is all. */
  series?: string;
  page?: number;
  pageSize?: number;
}

/** Articles the page adds each time its end scrolls into view. */
export const CARTON_STOCK_PAGE_SIZE = 20;
/** The most articles one read may return, whatever the screen asks. */
export const CARTON_STOCK_MOST_SHOWN = 2000;

const naturally = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

const buildArticle = (article: string, figures: readonly CartonStockFigure[]): CartonMatrixArticle => {
  const colours = [...new Set(figures.map((figure) => attributeKey(figure.color)))].sort(naturally);
  const rows = new Map<string, CartonMatrixRow>();
  for (const figure of figures) {
    const size = attributeKey(figure.size);
    const row = rows.get(size) ?? { key: size, size, quantities: colours.map(() => 0), total: 0 };
    const column = colours.indexOf(attributeKey(figure.color));
    row.quantities[column] = roundQuantity((row.quantities[column] ?? 0) + figure.quantity);
    row.total = roundQuantity(row.total + figure.quantity);
    rows.set(size, row);
  }
  return { key: article, article, colours, rows: [...rows.values()].sort((a, b) => compareSizes(a.size, b.size)) };
};

export const buildCartonStockMatrix = (figures: readonly CartonStockFigure[], query: CartonStockQuery = {}): CartonStockMatrix => {
  const held = figures.filter((figure) => figure.quantity !== 0);
  const seriesOptions = [...new Set(held.map((figure) => attributeKey(figure.series)).filter(Boolean))].sort(naturally);

  const series = attributeKey(query.series);
  const words = attributeKey(query.search).split(/\s+/).filter(Boolean);
  const groups = new Map<string, CartonStockFigure[]>();
  for (const figure of held) {
    const name = attributeKey(figure.article);
    if (series && attributeKey(figure.series) !== series) continue;
    if (!words.every((word) => name.includes(word))) continue;
    groups.set(name, [...(groups.get(name) ?? []), figure]);
  }

  const articles = [...groups.entries()].sort(([a], [b]) => naturally(a, b)).map(([name, group]) => buildArticle(name, group));
  const pageSize = Math.max(Math.trunc(query.pageSize ?? CARTON_STOCK_PAGE_SIZE), 1);
  const pages = Math.max(Math.ceil(articles.length / pageSize), 1);
  const page = Math.min(Math.max(Math.trunc(query.page ?? 1), 1), pages);
  return {
    articles: articles.slice((page - 1) * pageSize, page * pageSize),
    articleCount: articles.length,
    page,
    pages,
    seriesOptions,
  };
};
