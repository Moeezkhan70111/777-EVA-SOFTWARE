import { compareSizes, orderQuantityProblem } from "@erp/domain";
import type { GridSize } from "../../components/shared/SizeColourGrid";
import type { CustomerOrder, CustomerOrderArticleProduct, CustomerOrderLineInput } from "../../types/desktopApi";

// THE ORDER BEING TYPED (docs/52), before it is saved: a party, a note, and one block per article.
//
//   SK6   colours [RED] [BLUE] [BLACK]        sizes down, chosen colours across, a box per live product
//          6      10    15     5
//          7      20    10     8
//
// A block holds the article's live products (from Product Master), the colours chosen for it, and what was typed in
// each box, by product. A colour taken off keeps nothing: its boxes leave the order. A box with nothing typed is no
// line. Only a live product has a box, so an order can never ask for a combination that does not exist.
//
// Pure: the screen's hooks keep a draft in state and ask this what it means. Nothing here is trusted by the main
// process, which checks every line again.

export interface ArticleBlock {
  readonly article: string;
  readonly products: readonly CustomerOrderArticleProduct[];
  /** The colours chosen, in the article's own colour order. */
  readonly colours: readonly string[];
  /** What was typed, by product id. */
  readonly typed: Readonly<Record<string, string>>;
  /** What gatepasses already dispatched, by product id, when an order is being edited: a box may not go below it. */
  readonly dispatched: Readonly<Record<string, number>>;
}

export interface OrderDraft {
  readonly partyId: string;
  readonly note: string;
  readonly blocks: readonly ArticleBlock[];
}

export const emptyOrderDraft: OrderDraft = { partyId: "", note: "", blocks: [] };

export interface ArticleGrid {
  readonly sizes: readonly GridSize[];
  /** Every colour the article has on any size, in order. */
  readonly colours: readonly string[];
  /** The live product in each box, by cellKey(size, colour). A missing box is a combination that is not made. */
  readonly cells: ReadonlyMap<string, string>;
}

export const cellKey = (size: string, colour: string): string => `${size}\u0000${colour}`;

/** An article's products as a grid: sizes in the store's order, colours alphabetically. */
export function articleGrid(products: readonly CustomerOrderArticleProduct[]): ArticleGrid {
  const sizes = [...new Set(products.map((product) => product.size))].sort(compareSizes).map((size) => ({ id: size, size }));
  const colours = [...new Set(products.map((product) => product.color))].sort();
  return { sizes, colours, cells: new Map(products.map((product) => [cellKey(product.size, product.color), product.productVariantId])) };
}

/** A new block for an article, with no colour chosen yet. */
export const newBlock = (article: string, products: readonly CustomerOrderArticleProduct[]): ArticleBlock => ({ article, products, colours: [], typed: {}, dispatched: {} });

/** The block with `colour` chosen or taken off. Taking a colour off drops what was typed in its boxes. */
export function toggleColour(block: ArticleBlock, colour: string): ArticleBlock {
  const order = articleGrid(block.products).colours;
  if (!block.colours.includes(colour)) {
    return { ...block, colours: order.filter((each) => each === colour || block.colours.includes(each)) };
  }
  const leaving = new Set(block.products.filter((product) => product.color === colour).map((product) => product.productVariantId));
  const typed = Object.fromEntries(Object.entries(block.typed).filter(([productId]) => !leaving.has(productId)));
  return { ...block, colours: block.colours.filter((each) => each !== colour), typed };
}

/**
 * The block after the article was read again (a new colour added in Product Master): products it already had are kept
 * (an order being edited may hold one since retired), the new ones join, and `colour` is chosen if it is not already.
 */
export function withProducts(block: ArticleBlock, products: readonly CustomerOrderArticleProduct[], colour: string): ArticleBlock {
  const known = new Map(block.products.map((product) => [product.productVariantId, product]));
  for (const product of products) known.set(product.productVariantId, product);
  const refreshed = { ...block, products: [...known.values()] };
  const stored = refreshed.products.find((product) => product.color.toUpperCase() === colour.toUpperCase())?.color;
  return stored && !refreshed.colours.includes(stored) ? toggleColour(refreshed, stored) : refreshed;
}

/** A colour that has dispatched cartons on the order being edited cannot be taken off. */
export const colourLocked = (block: ArticleBlock, colour: string): boolean =>
  block.products.some((product) => product.color === colour && (block.dispatched[product.productVariantId] ?? 0) > 0);

const chosenProducts = (block: ArticleBlock) => block.products.filter((product) => block.colours.includes(product.color));

/** Why a box cannot be saved, by product id. Empty boxes are not problems. */
export function blockProblems(block: ArticleBlock): Map<string, string> {
  const problems = new Map<string, string>();
  for (const product of chosenProducts(block)) {
    const typed = block.typed[product.productVariantId] ?? "";
    const problem = orderQuantityProblem(typed);
    const dispatched = block.dispatched[product.productVariantId] ?? 0;
    if (problem) problems.set(product.productVariantId, problem);
    else if (dispatched > 0 && Number(typed.trim() || 0) < dispatched) problems.set(product.productVariantId, `At least ${dispatched}: already dispatched.`);
  }
  return problems;
}

/** The block's saveable lines: every chosen box with a whole number typed in it. */
export function blockLines(block: ArticleBlock): CustomerOrderLineInput[] {
  return chosenProducts(block)
    .map((product) => ({ productVariantId: product.productVariantId, typed: (block.typed[product.productVariantId] ?? "").trim() }))
    .filter((cell) => cell.typed !== "" && orderQuantityProblem(cell.typed) === null)
    .map((cell) => ({ productVariantId: cell.productVariantId, quantity: Number(cell.typed) }));
}

/** Cartons typed per chosen colour, and in the whole block. */
export function blockTotals(block: ArticleBlock): { byColour: Map<string, number>; total: number } {
  const byId = new Map(block.products.map((product) => [product.productVariantId, product.color]));
  const byColour = new Map(block.colours.map((colour) => [colour, 0]));
  let total = 0;
  for (const line of blockLines(block)) {
    const colour = byId.get(line.productVariantId) ?? "";
    byColour.set(colour, (byColour.get(colour) ?? 0) + line.quantity);
    total += line.quantity;
  }
  return { byColour, total };
}

export const draftLines = (draft: OrderDraft): CustomerOrderLineInput[] => draft.blocks.flatMap(blockLines);

export const draftTotal = (draft: OrderDraft): number => draftLines(draft).reduce((sum, line) => sum + line.quantity, 0);

export const draftProblemCount = (draft: OrderDraft): number => draft.blocks.reduce((sum, block) => sum + blockProblems(block).size, 0);

/** Whether the draft can be sent: a party, at least one line, and no box with a problem. */
export const draftReady = (draft: OrderDraft): boolean => draft.partyId !== "" && draftLines(draft).length > 0 && draftProblemCount(draft) === 0;

/** A stored order back as a draft, for editing: one block per article, its colours chosen, its quantities typed. */
export function draftFromOrder(order: CustomerOrder, productsOf: (article: string) => readonly CustomerOrderArticleProduct[]): OrderDraft {
  const articles = [...new Set(order.lines.map((line) => line.article))];
  const blocks = articles.map((article) => {
    const lines = order.lines.filter((line) => line.article === article);
    // The order's own products are always offered, even if Product Master has since retired one.
    const known = new Map(productsOf(article).map((product) => [product.productVariantId, product]));
    for (const line of lines) if (!known.has(line.productVariantId)) known.set(line.productVariantId, { productVariantId: line.productVariantId, size: line.size, color: line.color });
    const products = [...known.values()];
    const colours = articleGrid(products).colours.filter((colour) => lines.some((line) => line.color === colour));
    return {
      article,
      products,
      colours,
      typed: Object.fromEntries(lines.map((line) => [line.productVariantId, String(line.quantity)])),
      dispatched: Object.fromEntries(lines.map((line) => [line.productVariantId, line.dispatched])),
    };
  });
  return { partyId: order.partyId, note: order.note ?? "", blocks };
}
