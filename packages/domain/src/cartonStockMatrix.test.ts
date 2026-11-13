import test from "node:test";
import assert from "node:assert/strict";
import { buildCartonStockMatrix, type CartonStockFigure } from "./cartonStockMatrix.js";

const figure = (article: string, size: string, color: string, quantity: number, series = "SKECHERS"): CartonStockFigure => ({ article, size, color, series, quantity });

// The owner's example (the Carton Stock design): every figure worked out, none stored.
const STOCK = [
  figure("SK6", "7/10", "RED", 2), figure("SK6", "7/10", "BLUE", 6), figure("SK6", "7/10", "GREEN", 4), figure("SK6", "7/10", "BROWN", 2),
  figure("SK6", "4/6", "RED", 5), figure("SK6", "4/6", "GREEN", 5), figure("SK6", "4/6", "BROWN", 5),
  figure("SK6", "1/3", "GREEN", 5),
  figure("SK12", "7/10", "BLUE", 5), figure("SK12", "7/10", "MUSTARD", 6), figure("SK12", "7/10", "GREEN", 3), figure("SK12", "7/10", "RED", 2),
  figure("AR3", "4/6", "RED", 3, "AR"),
  figure("DC3", "7/10", "SKIN", 9, ""),
];

test("works out the owner's example, one Total per size, sizes in the store's order", () => {
  const { articles } = buildCartonStockMatrix(STOCK);
  assert.deepEqual(articles.map((article) => article.article), ["AR3", "DC3", "SK6", "SK12"]);
  const sk6 = articles.find((article) => article.article === "SK6");
  assert.deepEqual(sk6?.colours, ["BLUE", "BROWN", "GREEN", "RED"]);
  assert.deepEqual(sk6?.rows.map((row) => [row.size, row.total]), [["7/10", 14], ["4/6", 15], ["1/3", 5]]);
  assert.deepEqual(sk6?.rows.find((row) => row.size === "4/6")?.quantities, [0, 5, 5, 5]);
  assert.equal(articles.find((article) => article.article === "SK12")?.rows[0]?.total, 16);
});

test("adds every size up per colour, and the whole article into a grand total", () => {
  const sk6 = buildCartonStockMatrix(STOCK).articles.find((article) => article.article === "SK6");
  assert.deepEqual(sk6?.colourTotals, [6, 7, 14, 7]);
  assert.equal(sk6?.total, 34);
  const [negative] = buildCartonStockMatrix([figure("SK6", "7/10", "RED", -2), figure("SK6", "4/6", "RED", 5)]).articles;
  assert.deepEqual(negative?.colourTotals, [3]);
  assert.equal(negative?.total, 3);
});

test("leaves out products with nothing in store, and articles with nothing at all", () => {
  const { articles, seriesOptions } = buildCartonStockMatrix([...STOCK, figure("SK99", "7/10", "RED", 0, "EMPTY"), figure("SK6", "8/10", "PINK", 0)]);
  assert.equal(articles.some((article) => article.article === "SK99"), false);
  assert.equal(articles.find((article) => article.article === "SK6")?.colours.includes("PINK"), false);
  assert.equal(seriesOptions.some((option) => option.series === "EMPTY"), false);
});

test("shows a negative figure as it is, never hidden", () => {
  const [article] = buildCartonStockMatrix([figure("SK6", "7/10", "RED", -2), figure("SK6", "7/10", "BLUE", 5)]).articles;
  assert.deepEqual(article?.rows[0]?.quantities, [5, -2]);
  assert.equal(article?.rows[0]?.total, 3);
});

test("search and article series narrow it; the series picker always offers every series with stock", () => {
  const names = (query: Parameters<typeof buildCartonStockMatrix>[1]) => buildCartonStockMatrix(STOCK, query).articles.map((a) => a.article);
  assert.deepEqual(names({ search: "sk1" }), ["SK12"]);
  assert.deepEqual(names({ series: "skechers" }), ["SK6", "SK12"]);
  assert.deepEqual(names({ series: "AR" }), ["AR3"]);
  const narrowed = buildCartonStockMatrix(STOCK, { series: "AR", search: "zzz" });
  assert.equal(narrowed.articleCount, 0);
  assert.deepEqual(narrowed.seriesOptions.map((option) => option.series), ["AR", "SKECHERS"]);
  assert.equal(buildCartonStockMatrix(STOCK, { search: "velcro" }).articleCount, 0);
});

test("a product with no series shows under All, and never under a series", () => {
  assert.equal(buildCartonStockMatrix(STOCK).articles.some((a) => a.article === "DC3"), true);
  assert.equal(buildCartonStockMatrix(STOCK, { series: "AR" }).articles.some((a) => a.article === "DC3"), false);
});

test("an article whose sizes sit in two series shows only that series' sizes under it", () => {
  const stock = [figure("SK6", "7/10", "RED", 4, "A"), figure("SK6", "4/6", "RED", 3, "B")];
  const [article] = buildCartonStockMatrix(stock, { series: "B" }).articles;
  assert.deepEqual(article?.rows.map((row) => [row.size, row.total]), [["4/6", 3]]);
});

test("adds the same words in any case and spacing as one product", () => {
  const [article] = buildCartonStockMatrix([figure("sk6 ", "7/10", "red", 1), figure("SK6", " 7/10", "RED ", 2)]).articles;
  assert.deepEqual(article?.rows.map((row) => row.quantities), [[3]]);
});

test("each series in the picker says how many articles it has and their cartons; All is the whole store", () => {
  const matrix = buildCartonStockMatrix(STOCK, { search: "velcro", series: "AR" });
  assert.deepEqual(matrix.seriesOptions, [{ series: "AR", articles: 1, cartons: 3 }, { series: "SKECHERS", articles: 2, cartons: 50 }]);
  assert.deepEqual(matrix.allSeries, { articles: 4, cartons: 62 });
});

test("pages by article", () => {
  const page = buildCartonStockMatrix(STOCK, { pageSize: 3, page: 9 });
  assert.deepEqual([page.page, page.pages, page.articleCount, page.articles.length], [2, 2, 4, 1]);
});

test("the total carton stock counts every matching article, not only the page shown", () => {
  assert.equal(buildCartonStockMatrix(STOCK, { pageSize: 1 }).totalCartons, 62);
  assert.equal(buildCartonStockMatrix(STOCK, { series: "SKECHERS" }).totalCartons, 50);
  assert.equal(buildCartonStockMatrix(STOCK, { search: "velcro" }).totalCartons, 0);
});
