import test from "node:test";
import assert from "node:assert/strict";
import { UPPER_STOCK_CATEGORY, UPPER_STOCK_SORT, buildUpperStockMatrix, type UpperStockMaterial } from "./upperStockMatrix.js";

let code = 0;
const material = (article: string | null, size: string | null, colour: string | null, onHand: number, overrides: Partial<UpperStockMaterial> = {}): UpperStockMaterial => {
  code += 1;
  return {
    itemCode: `RM-${String(code).padStart(6, "0")}`,
    displayName: `UPPER — RUBBER UPPER — ${article ?? ""} — ${colour ?? ""} — ${size ?? ""}`,
    categoryName: "RUBBER UPPER",
    article,
    size,
    colour,
    type: null,
    onHand,
    unitCode: "DOZEN",
    ...overrides,
  };
};

// The owner's example: every figure is worked out, none is stored.
const SK6 = [
  material("SK6", "7/10", "BLACK", 10), material("SK6", "7/10", "RED", 20), material("SK6", "7/10", "GREEN", 10),
  material("SK6", "4/6", "BLACK", 5), material("SK6", "4/6", "BLUE", 5), material("SK6", "4/6", "GREEN", 20), material("SK6", "4/6", "MUSTARD", 10),
  material("SK6", "1/3", "BLACK", 10), material("SK6", "1/3", "BLUE", 5), material("SK6", "1/3", "RED", 15), material("SK6", "1/3", "GREY", 5),
  material("SK6", "11/13", "BLACK", 2), material("SK6", "11/13", "BLUE", 4), material("SK6", "11/13", "RED", 2), material("SK6", "11/13", "GREEN", 3), material("SK6", "11/13", "MUSTARD", 5), material("SK6", "11/13", "GREY", 4),
  material("SK6", "8/10", "BLACK", 40), material("SK6", "8/10", "BLUE", 10), material("SK6", "8/10", "RED", 20), material("SK6", "8/10", "GREEN", 5),
];

test("works out the owner's example: size totals, one grand total, a gap for nothing", () => {
  const [article] = buildUpperStockMatrix(SK6).articles;
  assert.equal(article?.article, "SK6");
  assert.deepEqual(article?.colours, ["BLACK", "BLUE", "GREEN", "GREY", "MUSTARD", "RED"]);
  assert.deepEqual(article?.rows.map((row) => [row.size, row.total]), [["7/10", 40], ["4/6", 40], ["1/3", 35], ["11/13", 20], ["8/10", 75]]);
  assert.equal(article?.total, 210);
  const row = article?.rows.find((candidate) => candidate.size === "7/10");
  assert.deepEqual(row?.quantities, [10, 0, 10, 0, 0, 20]);
});

test("sizes follow the store's sequence, and any other size comes after, by number", () => {
  const sizes = ["6/7", "8/10", "24/29", "11/13", "1/3", "4/6", "8/13", "1/6", "7/10", "10/12"];
  const [article] = buildUpperStockMatrix(sizes.map((size) => material("SK6", size, "BLACK", 1))).articles;
  assert.deepEqual(article?.rows.map((row) => row.size), ["10/12", "7/10", "4/6", "1/3", "11/13", "8/10", "1/6", "8/13", "6/7", "24/29"]);
});

test("an article with only some of the sequence keeps their order, and L stays before R", () => {
  const [article] = buildUpperStockMatrix([
    material("DC1", "8/10", "BLACK", 1, { type: "R" }),
    material("DC1", "8/10", "BLACK", 1, { type: "L" }),
    material("DC1", "1/6", "BLACK", 1),
  ]).articles;
  assert.deepEqual(article?.rows.map((row) => [row.size, row.type]), [["8/10", "L"], ["8/10", "R"], ["1/6", ""]]);
});

test("the columns are the article's own colours, so no stock is left off the page", () => {
  const [article] = buildUpperStockMatrix([material("DC1", "6/7", "COMMANDO", 3), material("DC1", "6/7", "BLACK RED", 4), material("DC1", "8/9", "SAND GREY", 5)]).articles;
  assert.deepEqual(article?.colours, ["BLACK RED", "COMMANDO", "SAND GREY"]);
  assert.equal(article?.total, 12);
});

test("L and R stay two rows and are never added into one cell", () => {
  const [article] = buildUpperStockMatrix([
    material("DC1", "6/7", "BLACK", 12.5, { type: "L" }),
    material("DC1", "6/7", "BLACK", 12.5, { type: "R" }),
    material("DC1", "6/7", "BLACK", 1),
  ]).articles;
  assert.deepEqual(article?.rows.map((row) => [row.size, row.type, row.quantities[0]]), [["6/7", "", 1], ["6/7", "L", 12.5], ["6/7", "R", 12.5]]);
});

test("adds without floating point dust", () => {
  const [article] = buildUpperStockMatrix([material("A", "1/3", "BLACK", 0.1), material("A", "1/3", "RED", 0.2), material("A", "4/6", "RED", 0.7)]).articles;
  assert.equal(article?.rows.find((row) => row.size === "1/3")?.total, 0.3);
  assert.equal(article?.total, 1);
});

test("never adds across units: an article held in two is two matrices", () => {
  const { articles } = buildUpperStockMatrix([material("A", "1/3", "BLACK", 5), material("A", "1/3", "BLACK", 7, { unitCode: "PAIR" })]);
  assert.deepEqual(articles.map((article) => [article.unitCode, article.total]), [["DOZEN", 5], ["PAIR", 7]]);
});

test("keeps stock with a missing article, size or colour on the page", () => {
  const { articles } = buildUpperStockMatrix([material(null, "1/3", "BLACK", 2), material("DUMMY", "7/10", null, 6), material("X", null, "RED", 1)]);
  assert.equal(articles.reduce((sum, article) => sum + article.total, 0), 9);
  assert.deepEqual(articles.find((article) => article.article === "DUMMY")?.colours, [""]);
  assert.equal(articles.find((article) => article.article === "X")?.rows[0]?.size, "");
});

test("treats the same words in any case and spacing as one article, size and colour", () => {
  const { articles } = buildUpperStockMatrix([material("sk6 ", "7/10", "black", 1), material("SK6", " 7/10", "BLACK ", 2)]);
  assert.equal(articles.length, 1);
  assert.deepEqual(articles[0]?.rows.map((row) => row.quantities), [[3]]);
});

test("filters by category, and ALL holds everything including any other sub-category", () => {
  const stock = [
    material("A", "1/3", "BLACK", 1),
    material("B", "1/3", "BLACK", 2, { categoryName: "RAGZINE UPPER" }),
    material("C", "1/3", "BLACK", 3, { categoryName: "PVC UPPER" }),
    material("D", "1/3", "BLACK", 4, { categoryName: "PASTING UPPER" }),
    material("E", "1/3", "BLACK", 5, { categoryName: "UPPER" }),
  ];
  const names = (category: (typeof UPPER_STOCK_CATEGORY)[keyof typeof UPPER_STOCK_CATEGORY]) => buildUpperStockMatrix(stock, { category }).articles.map((article) => article.article);
  assert.deepEqual(names(UPPER_STOCK_CATEGORY.RUBBER), ["A"]);
  assert.deepEqual(names(UPPER_STOCK_CATEGORY.RAGZINE), ["B"]);
  assert.deepEqual(names(UPPER_STOCK_CATEGORY.PVC), ["C"]);
  assert.deepEqual(names(UPPER_STOCK_CATEGORY.PASTING), ["D"]);
  assert.deepEqual(names(UPPER_STOCK_CATEGORY.ALL), ["A", "B", "C", "D", "E"]);
});

test("a search keeps a matched article whole, so its totals stay true", () => {
  const stock = [material("SK6", "7/10", "BLACK", 1), material("SK6", "4/6", "RED", 2), material("DC1", "7/10", "CREAM", 4)];
  assert.deepEqual(buildUpperStockMatrix(stock, { search: "sk6" }).articles.map((article) => [article.article, article.total]), [["SK6", 3]]);
  assert.deepEqual(buildUpperStockMatrix(stock, { search: "black" }).articles.map((article) => [article.article, article.total]), [["SK6", 3]]);
  assert.equal(buildUpperStockMatrix(stock, { search: "velcro" }).articleCount, 0);
  assert.equal(buildUpperStockMatrix(stock, { search: "  " }).articleCount, 2);
});

test("sorts by name in natural order and by the article's whole stock", () => {
  const stock = [material("SK12", "1/3", "BLACK", 5), material("SK6", "1/3", "BLACK", 50), material("AR3", "1/3", "BLACK", 20), material("SK6", "4/6", "RED", 1)];
  const order = (sort: (typeof UPPER_STOCK_SORT)[keyof typeof UPPER_STOCK_SORT]) => buildUpperStockMatrix(stock, { sort }).articles.map((article) => article.article);
  assert.deepEqual(order(UPPER_STOCK_SORT.NAME_ASC), ["AR3", "SK6", "SK12"]);
  assert.deepEqual(order(UPPER_STOCK_SORT.NAME_DESC), ["SK12", "SK6", "AR3"]);
  assert.deepEqual(order(UPPER_STOCK_SORT.STOCK_DESC), ["SK6", "AR3", "SK12"]);
  assert.deepEqual(order(UPPER_STOCK_SORT.STOCK_ASC), ["SK12", "AR3", "SK6"]);
});

test("pages by article, and keeps one name in two sub-categories apart", () => {
  const stock = [material("A", "1/3", "BLACK", 1), material("B", "1/3", "BLACK", 1), material("C", "1/3", "BLACK", 1)];
  const last = buildUpperStockMatrix(stock, { pageSize: 2, page: 9 });
  assert.deepEqual([last.page, last.pages, last.articleCount, last.articles.length], [2, 2, 3, 1]);

  const same = buildUpperStockMatrix([material("A", "1/3", "BLACK", 1), material("A", "1/3", "BLACK", 1, { categoryName: "PVC UPPER" }), material("B", "1/3", "BLACK", 1)]);
  assert.deepEqual(same.articles.map((article) => [article.article, article.categoryName]), [["A", "PVC UPPER"], ["A", "RUBBER UPPER"], ["B", "RUBBER UPPER"]]);
});

test("an empty store is an empty list on one page", () => {
  assert.deepEqual(buildUpperStockMatrix([]), { articles: [], articleCount: 0, page: 1, pages: 1 });
});
