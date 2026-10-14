import type { ProductRow } from "../../types/desktopApi";

// What the Manual Production form offers: Article → Size → Colour, from the active products in
// Product Master. Only colours that already exist on the product are offered — stock is kept per
// colour, and this screen never creates one (the main process refuses an unknown colour anyway).

export interface ProductChoice {
  articleSizeId: string;
  article: string;
  size: string;
  colors: string[];
}

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** One choice per product (article + size), with its colours in order. */
export const toProductChoices = (rows: readonly ProductRow[]): ProductChoice[] =>
  rows.map((row) => ({
    articleSizeId: row.articleSizeId ?? row.id,
    article: row.article,
    size: row.size,
    colors: [...new Set(row.colors ?? [])].sort(byText),
  }));

/** Every article, once, in order. */
export const articlesOf = (choices: readonly ProductChoice[]): string[] =>
  [...new Set(choices.map((choice) => choice.article))].sort(byText);

/** The sizes the article is made in, in order. */
export const sizesOf = (choices: readonly ProductChoice[], article: string): ProductChoice[] =>
  choices.filter((choice) => choice.article === article).sort((a, b) => byText(a.size, b.size));
