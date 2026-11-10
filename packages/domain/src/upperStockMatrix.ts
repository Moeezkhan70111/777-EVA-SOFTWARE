// The Upper Stock page's matrix: each article as Size down the side and Colour across the top.
//
// This only arranges figures the stock balances already hold (listUpperStock). It adds balances up
// but never decides what they mean, which is why these rules stand:
//
//   COLUMNS ARE THE ARTICLE'S OWN COLOURS. The store has dozens of colours, so a fixed set of
//   columns would leave stock off the page while the totals still counted it.
//
//   A TYPE IS ITS OWN ROW. The same article, size and colour can be two materials: L and R, or
//   OLD beside new. They are never added into one cell, so the page never says 25 for 12.5 + 12.5
//   of what may be two halves of the same uppers. Each stays visible under its own name.
//
//   TOTALS NEVER CROSS UNITS. An article held in two units is two matrices.
//
//   A SEARCH CHOOSES ARTICLES, NOT CELLS. A matched article shows whole, so its totals stay true.

import { attributeKey, roundQuantity } from "./machineProgram.js";

/** The four kinds of upper, by their Raw Material sub-category. ALL is every upper there is. */
export const UPPER_STOCK_CATEGORY = {
  ALL: "ALL",
  RUBBER: "RUBBER UPPER",
  RAGZINE: "RAGZINE UPPER",
  PVC: "PVC UPPER",
  PASTING: "PASTING UPPER",
} as const;
export type UpperStockCategory = (typeof UPPER_STOCK_CATEGORY)[keyof typeof UPPER_STOCK_CATEGORY];

export const UPPER_STOCK_SORT = {
  NAME_ASC: "NAME_ASC",
  NAME_DESC: "NAME_DESC",
  STOCK_DESC: "STOCK_DESC",
  STOCK_ASC: "STOCK_ASC",
} as const;
export type UpperStockSort = (typeof UPPER_STOCK_SORT)[keyof typeof UPPER_STOCK_SORT];

/** Articles on one page. */
export const UPPER_STOCK_PAGE_SIZE = 20;

/** What the matrix reads of one material: a subset of the data layer's UpperStockRow. */
export interface UpperStockMaterial {
  itemCode: string;
  displayName: string;
  categoryName: string;
  article: string | null;
  size: string | null;
  colour: string | null;
  type: string | null;
  onHand: number;
  unitCode: string;
}

export interface UpperMatrixRow {
  key: string;
  /** "" when the material has no size. */
  size: string;
  /** "" for a plain upper; L, R, OLD … otherwise. */
  type: string;
  /** One per colour of the article, in the same order. 0 is shown as a dash. */
  quantities: number[];
  total: number;
}

export interface UpperMatrixArticle {
  key: string;
  /** "" when the material has no article. */
  article: string;
  categoryName: string;
  unitCode: string;
  /** "" is a material with no colour. */
  colours: string[];
  rows: UpperMatrixRow[];
  total: number;
}

export interface UpperStockMatrix {
  articles: UpperMatrixArticle[];
  /** Matching articles across every page. */
  articleCount: number;
  page: number;
  pages: number;
}

export interface UpperStockQuery {
  category?: UpperStockCategory;
  search?: string;
  sort?: UpperStockSort;
  page?: number;
  pageSize?: number;
}

/** Numbers by value, so SK6 comes before SK12 and 4/6 before 11/13. */
const naturally = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

const byName = (a: UpperMatrixArticle, b: UpperMatrixArticle): number =>
  naturally(a.article, b.article) || naturally(a.categoryName, b.categoryName) || naturally(a.unitCode, b.unitCode);

const COMPARE: Record<UpperStockSort, (a: UpperMatrixArticle, b: UpperMatrixArticle) => number> = {
  [UPPER_STOCK_SORT.NAME_ASC]: byName,
  [UPPER_STOCK_SORT.NAME_DESC]: (a, b) => byName(b, a),
  [UPPER_STOCK_SORT.STOCK_DESC]: (a, b) => b.total - a.total || byName(a, b),
  [UPPER_STOCK_SORT.STOCK_ASC]: (a, b) => a.total - b.total || byName(a, b),
};

const articleKey = (material: UpperStockMaterial): string =>
  [attributeKey(material.categoryName), attributeKey(material.article), attributeKey(material.unitCode)].join("|");

const rowKey = (size: string, type: string): string => `${size}|${type}`;

/**
 * The store reads these sizes in this order, the owner's sequence, not by number. They come first,
 * in this order, whichever of them an article has. Any other size follows, in number order.
 */
export const UPPER_SIZE_ORDER: readonly string[] = ["10/12", "7/10", "4/6", "1/3", "11/13", "8/10", "1/6", "8/13"];

const sizeRank = (size: string): number => {
  const rank = UPPER_SIZE_ORDER.indexOf(size);
  return rank < 0 ? UPPER_SIZE_ORDER.length : rank;
};

/** The store's size order, for uppers and cartons alike: the sequence above first, then by number. */
export const compareSizes = (a: string, b: string): number => sizeRank(a) - sizeRank(b) || naturally(a, b);

/** One article's materials as a matrix. */
const buildArticle = (key: string, materials: readonly UpperStockMaterial[]): UpperMatrixArticle => {
  const colours = [...new Set(materials.map((material) => attributeKey(material.colour)))].sort(naturally);
  const rows = new Map<string, UpperMatrixRow>();
  for (const material of materials) {
    const size = attributeKey(material.size);
    const type = attributeKey(material.type);
    const id = rowKey(size, type);
    const row = rows.get(id) ?? { key: id, size, type, quantities: colours.map(() => 0), total: 0 };
    const column = colours.indexOf(attributeKey(material.colour));
    row.quantities[column] = roundQuantity((row.quantities[column] ?? 0) + material.onHand);
    row.total = roundQuantity(row.total + material.onHand);
    rows.set(id, row);
  }
  const ordered = [...rows.values()].sort((a, b) => compareSizes(a.size, b.size) || naturally(a.type, b.type));
  const [first] = materials;
  return {
    key,
    article: attributeKey(first?.article),
    categoryName: attributeKey(first?.categoryName),
    unitCode: first?.unitCode ?? "",
    colours,
    rows: ordered,
    total: roundQuantity(ordered.reduce((sum, row) => sum + row.total, 0)),
  };
};

/** Every word somewhere in the article's name, or in the names and codes of its materials. */
const matchesSearch = (materials: readonly UpperStockMaterial[], search: string): boolean => {
  const words = attributeKey(search).split(/\s+/).filter(Boolean);
  const text = attributeKey(materials.map((material) => `${material.article ?? ""} ${material.displayName} ${material.itemCode}`).join(" "));
  return words.every((word) => text.includes(word));
};

export const buildUpperStockMatrix = (materials: readonly UpperStockMaterial[], query: UpperStockQuery = {}): UpperStockMatrix => {
  const category = query.category ?? UPPER_STOCK_CATEGORY.ALL;
  const groups = new Map<string, UpperStockMaterial[]>();
  for (const material of materials) {
    if (category !== UPPER_STOCK_CATEGORY.ALL && attributeKey(material.categoryName) !== category) continue;
    const key = articleKey(material);
    groups.set(key, [...(groups.get(key) ?? []), material]);
  }

  const articles = [...groups.entries()]
    .filter(([, group]) => matchesSearch(group, query.search ?? ""))
    .map(([key, group]) => buildArticle(key, group))
    .sort(COMPARE[query.sort ?? UPPER_STOCK_SORT.NAME_ASC]);

  const pageSize = Math.max(Math.trunc(query.pageSize ?? UPPER_STOCK_PAGE_SIZE), 1);
  const pages = Math.max(Math.ceil(articles.length / pageSize), 1);
  const page = Math.min(Math.max(Math.trunc(query.page ?? 1), 1), pages);
  return {
    articles: articles.slice((page - 1) * pageSize, page * pageSize),
    articleCount: articles.length,
    page,
    pages,
  };
};
