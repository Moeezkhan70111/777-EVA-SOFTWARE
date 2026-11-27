import { cartonsToDozens, compareSizes, normalizeQrColor, orderDozensProblem, orderDozensToCartons } from "@erp/domain";
import { orderDozens } from "./orderUnits";
import type { GridSize } from "../../components/shared/SizeColourGrid";
import type { CustomerOrder, CustomerOrderArticleProduct, CustomerOrderLineInput } from "../../types/desktopApi";

// THE ORDER BEING TYPED (docs/52), before it is saved: a party, a note, and one block per article.
//
//   SK6          RED   BLUE   BLACK       sizes down, EVERY colour across, a box per live product
//          6      10    15     5
//          7      20    10     8
//
// A block holds the article's live products (from Product Master), its colours, and what was typed in each box, by
// product. Every colour is open at once (owner, 27 Nov 2026: "DONT MAKE IT SELECT THE COLOR FIRST. OPEN ALL THE COLORS
// IN THE TABLE"): a box with nothing typed is no line. Only a live product has a box, so an order can never ask for a
// combination that does not exist.
//
// Pure: the screen's hooks keep a draft in state and ask this what it means. Nothing here is trusted by the main
// process, which checks every line again.

export interface ArticleBlock {
  readonly article: string;
  readonly products: readonly CustomerOrderArticleProduct[];
  /** Every colour the article has on any size, in the article's own colour order: each one a column. */
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

/** A just-added article, every colour open. */
export const newBlock = (article: string, products: readonly CustomerOrderArticleProduct[]): ArticleBlock =>
  ({ article, products, colours: articleGrid(products).colours, typed: {}, dispatched: {} });

/**
 * The block after the article was read again (a new colour added in Product Master): products it already had are kept
 * (an order being edited may hold one since retired), the new ones join, and the new colour opens as a column.
 */
export function withProducts(block: ArticleBlock, products: readonly CustomerOrderArticleProduct[]): ArticleBlock {
  const known = new Map(block.products.map((product) => [product.productVariantId, product]));
  for (const product of products) known.set(product.productVariantId, product);
  const merged = [...known.values()];
  return { ...block, products: merged, colours: articleGrid(merged).colours };
}

/**
 * The block after a colour was removed from the article in Product Master: the products as read again, so the removed
 * colour's column goes, and anything typed in its boxes goes with it. (Removal is refused while an open order line
 * still needs the colour, so an order being edited never loses a stored line here.)
 */
export function withoutRemoved(block: ArticleBlock, products: readonly CustomerOrderArticleProduct[]): ArticleBlock {
  const live = new Set(products.map((product) => product.productVariantId));
  const typed = Object.fromEntries(Object.entries(block.typed).filter(([productId]) => live.has(productId)));
  return { ...block, products, colours: articleGrid(products).colours, typed };
}

/**
 * Colours asked of the Product Master computer (Enter Orders on the orders computer, 27 Nov 2026) that the article does
 * not have yet: the ones still to wait for. Compared as a carton QR reads a colour (normalizeQrColor), so BLACKMUSTARD
 * arriving settles BLACK MUSTARD.
 */
export function stillAsked(asked: readonly string[], products: readonly CustomerOrderArticleProduct[]): string[] {
  const held = new Set(products.map((product) => normalizeQrColor(product.color)));
  return asked.filter((colour) => !held.has(normalizeQrColor(colour)));
}

const chosenProducts = (block: ArticleBlock) => block.products.filter((product) => block.colours.includes(product.color));

/** Why a box cannot be saved, by product id. Empty boxes are not problems. */
export function blockProblems(block: ArticleBlock): Map<string, string> {
  const problems = new Map<string, string>();
  for (const product of chosenProducts(block)) {
    // Typed in dozens; dispatched is in cartons, as stored. Compared in cartons, said in dozens.
    const typed = block.typed[product.productVariantId] ?? "";
    const problem = orderDozensProblem(typed);
    const dispatched = block.dispatched[product.productVariantId] ?? 0;
    const typedCartons = typed.trim() === "" ? 0 : orderDozensToCartons(typed);
    if (problem) problems.set(product.productVariantId, problem);
    else if (dispatched > 0 && typedCartons < dispatched) problems.set(product.productVariantId, `At least ${orderDozens(dispatched)} dozen: already dispatched.`);
  }
  return problems;
}

/** The block's saveable lines, in cartons as stored: every chosen box with whole or half dozens typed in it. */
export function blockLines(block: ArticleBlock): CustomerOrderLineInput[] {
  return chosenProducts(block)
    .map((product) => ({ productVariantId: product.productVariantId, typed: (block.typed[product.productVariantId] ?? "").trim() }))
    .filter((cell) => cell.typed !== "" && orderDozensProblem(cell.typed) === null)
    .map((cell) => ({ productVariantId: cell.productVariantId, quantity: orderDozensToCartons(cell.typed) }));
}

/** Cartons per chosen colour, and in the whole block (shown in dozens, orderUnits.ts). */
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

/** A stored order back as a draft, for editing: one block per article, every colour open, its quantities typed. */
export function draftFromOrder(order: CustomerOrder, productsOf: (article: string) => readonly CustomerOrderArticleProduct[]): OrderDraft {
  const articles = [...new Set(order.lines.map((line) => line.article))];
  const blocks = articles.map((article) => {
    const lines = order.lines.filter((line) => line.article === article);
    // The order's own products are always offered, even if Product Master has since retired one.
    const known = new Map(productsOf(article).map((product) => [product.productVariantId, product]));
    for (const line of lines) if (!known.has(line.productVariantId)) known.set(line.productVariantId, { productVariantId: line.productVariantId, size: line.size, color: line.color });
    const products = [...known.values()];
    return {
      article,
      products,
      colours: articleGrid(products).colours,
      // Stored cartons back as the dozens they were typed in.
      typed: Object.fromEntries(lines.map((line) => [line.productVariantId, String(cartonsToDozens(line.quantity))])),
      dispatched: Object.fromEntries(lines.map((line) => [line.productVariantId, line.dispatched])),
    };
  });
  return { partyId: order.partyId, note: order.note ?? "", blocks };
}

/** What is still to do before an order can be saved, the first thing missing first. */
export type OrderNextStep = "party" | "articles" | "dozens" | "fix" | "ready";

export interface OrderSteps {
  readonly party: boolean;
  readonly articles: boolean;
  readonly dozens: boolean;
  readonly next: OrderNextStep;
}

/**
 * The three steps of an order — a party, an article with its colours, the dozens typed — and the next one to do
 * (Zeigarnik and goal-gradient, owner, 24 Nov 2026): shown beside the total, so what is unfinished stays in view.
 */
export function draftSteps(draft: OrderDraft): OrderSteps {
  const party = draft.partyId !== "";
  const articles = draft.blocks.length > 0;
  const dozens = draftLines(draft).length > 0;
  const fix = draftProblemCount(draft) > 0;
  const next: OrderNextStep = !party ? "party" : !articles ? "articles" : fix ? "fix" : !dozens ? "dozens" : "ready";
  return { party, articles, dozens, next };
}
