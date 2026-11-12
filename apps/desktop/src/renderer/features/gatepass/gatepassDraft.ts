import { stockAfterGatepass } from "@erp/domain";
import type { Gatepass, GatepassLineInput } from "../../types/desktopApi";
import { articleWithGroup, compareNatural, rowKeyOf, type StockGrid, type StockGridRow } from "../../utils/gatepassGrid";
import { copy } from "../../config/copy";

// The Gatepass being written, as pure data.
//
// The clerk adds an article + size ("SK6 · 7/10"), sees every colour the store holds for
// it with its three figures — Current Stock (physically In Store), Reserved (owed to other
// outstanding Gatepasses) and Reflected Stock (what this document may take) — and types how
// many cartons go on the Gatepass. More than Reflected Stock is allowed (owner, 12 Nov 2026): the
// store goes below zero until Manual Production makes it up, and the line says so. This module turns those
// typed texts into checked quantities, per-article totals and the lines that are sent to
// CreateGatepassUseCase. No React, no I/O — the page and the summary panel both read from
// here so there is one set of totals on screen.
//
// Nothing here moves stock: the use case re-reads all three figures inside its transaction.

// ─── Quantity validation ─────────────────────────────────────────────────────
// Empty and "0" both mean "this colour is not on the Gatepass".

export interface QuantityCheck {
  /** Parsed cartons; 0 when the box is empty; null when the text is not usable. */
  value: number | null;
  error: string | null;
}

export const checkQuantity = (text: string): QuantityCheck => {
  const trimmed = text.trim();
  if (trimmed === "") return { value: 0, error: null };
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return { value: null, error: copy.gatepass.qtyNotWhole };
  const value = Number(trimmed);
  if (value < 0) return { value: null, error: copy.gatepass.qtyNegative };
  if (!Number.isInteger(value)) return { value: null, error: copy.gatepass.qtyFraction };
  return { value, error: null };
};

/** The − / + buttons: one carton up or down from what is typed, never below 0. Above Reflected Stock is allowed. */
export const stepQuantity = (text: string, delta: 1 | -1): number => {
  const parsed = Number(text.trim());
  const current = Number.isInteger(parsed) ? parsed : 0;
  return Math.max(0, current + delta);
};

// ─── Draft model ─────────────────────────────────────────────────────────────

export interface DraftColour {
  productVariantId: string;
  colour: string;
  /** Current Stock: cartons physically In Store for this article + colour + size. */
  currentStock: number;
  /** Reserved: cartons still owed to other outstanding Gatepasses. */
  reserved: number;
  /** Reflected Stock: currentStock − reserved, as the backend will re-check it. */
  reflected: number;
  /** What this document can take without the store going below zero: Reflected Stock, never below 0. */
  available: number;
  /** The In Store figure once this line is made (Current Stock − quantity), as Carton Stock shows it. Below zero: production is owed. */
  after: number;
  /** Exactly what the clerk typed. */
  text: string;
  check: QuantityCheck;
  /** A stored document only: what Store Move Out has scanned out, what was issued directly (docs/42), and what is left to scan. */
  progress?: { dispatchedFromStore: number; issuedDirectly: number; outstanding: number };
}

export interface DraftArticle {
  /** Grid row key: "SK6 7/10". */
  key: string;
  article: string;
  size: string;
  /** Product group of the article + size; null when the article has none set. */
  groupName: string | null;
  colours: DraftColour[];
  /** Colours with a quantity above zero. */
  selectedCount: number;
  /** Cartons across every colour. */
  total: number;
  errorCount: number;
}

export interface GatepassDraft {
  /** In the order the clerk added them. */
  articles: DraftArticle[];
  /** Articles with at least one carton. */
  articleCount: number;
  /** Colours with at least one carton, across every article. */
  colourCount: number;
  total: number;
  errorCount: number;
  /** What is sent to the backend, in document order: article, size, then colour. */
  lines: GatepassLineInput[];
}

const buildArticle = (row: StockGridRow, inputs: Record<string, string>): DraftArticle => {
  const colours = Object.keys(row.cells)
    .sort(compareNatural)
    .map((colour) => {
      const cell = row.cells[colour];
      const text = inputs[cell.productVariantId] ?? "";
      return {
        productVariantId: cell.productVariantId,
        colour,
        currentStock: cell.currentStock,
        reserved: cell.reserved,
        reflected: cell.reflected,
        available: cell.available,
        after: stockAfterGatepass(cell.currentStock, checkQuantity(text).value ?? 0),
        text,
        check: checkQuantity(text),
      };
    });
  return {
    key: row.key,
    article: row.article,
    size: row.size,
    groupName: row.groupName,
    colours,
    selectedCount: colours.filter((c) => (c.check.value ?? 0) > 0).length,
    total: colours.reduce((sum, c) => sum + (c.check.value ?? 0), 0),
    errorCount: colours.filter((c) => c.check.error).length,
  };
};

export const buildDraft = (grid: StockGrid, addedKeys: string[], inputs: Record<string, string>): GatepassDraft => {
  const rowsByKey = new Map(grid.rows.map((row) => [row.key, row]));
  const articles: DraftArticle[] = [];
  for (const key of addedKeys) {
    const row = rowsByKey.get(key);
    // An article the store no longer holds at all drops off the draft; the create
    // rejection (if it got that far) names it so nothing vanishes silently.
    if (row) articles.push(buildArticle(row, inputs));
  }

  const lines: GatepassLineInput[] = [...articles]
    .sort((a, b) => compareNatural(a.article, b.article) || compareNatural(a.size, b.size))
    .flatMap((article) =>
      article.colours
        .filter((c) => (c.check.value ?? 0) > 0)
        .map((c) => ({ productVariantId: c.productVariantId, quantity: c.check.value as number, reflectedStockSeen: c.reflected }))
    );

  return {
    articles,
    articleCount: articles.filter((a) => a.total > 0).length,
    colourCount: articles.reduce((sum, a) => sum + a.selectedCount, 0),
    total: articles.reduce((sum, a) => sum + a.total, 0),
    errorCount: articles.reduce((sum, a) => sum + a.errorCount, 0),
    lines,
  };
};

/**
 * A stored Gatepass in the draft's shape, so the same cards and summary show it read-only
 * (previous / next / load). `currentStock` carries the In Store figure at creation; the
 * reservation figures are not part of a stored document, so `reserved` is 0 and `progress`
 * carries what Store Move Out has taken for each line so far.
 */
export const buildDraftFromDocument = (document: Pick<Gatepass, "lines">): GatepassDraft => {
  const byKey = new Map<string, DraftArticle>();
  for (const line of document.lines) {
    const key = rowKeyOf(line.article, line.size);
    let article = byKey.get(key);
    if (!article) {
      article = { key, article: line.article, size: line.size, groupName: line.groupName ?? null, colours: [], selectedCount: 0, total: 0, errorCount: 0 };
      byKey.set(key, article);
    }
    article.colours.push({
      productVariantId: line.productVariantId,
      colour: line.color,
      currentStock: line.storeQuantityAtCreation,
      reserved: 0,
      reflected: line.storeQuantityAtCreation,
      available: line.storeQuantityAtCreation,
      after: stockAfterGatepass(line.storeQuantityAtCreation, line.quantity),
      text: String(line.quantity),
      check: { value: line.quantity, error: null },
      progress: { dispatchedFromStore: line.dispatchedFromStoreQuantity, issuedDirectly: line.issuedDirectlyQuantity, outstanding: line.outstandingQuantity },
    });
  }
  const articles = Array.from(byKey.values()).sort((a, b) => compareNatural(a.article, b.article) || compareNatural(a.size, b.size));
  for (const article of articles) {
    article.colours.sort((a, b) => compareNatural(a.colour, b.colour));
    article.selectedCount = article.colours.filter((c) => (c.check.value ?? 0) > 0).length;
    article.total = article.colours.reduce((sum, c) => sum + (c.check.value ?? 0), 0);
  }
  return {
    articles,
    articleCount: articles.filter((a) => a.total > 0).length,
    colourCount: articles.reduce((sum, a) => sum + a.selectedCount, 0),
    total: articles.reduce((sum, a) => sum + a.total, 0),
    errorCount: 0,
    lines: articles.flatMap((a) => a.colours.map((c) => ({ productVariantId: c.productVariantId, quantity: c.check.value ?? 0, reflectedStockSeen: c.reflected }))),
  };
};

/** Why Create is not allowed yet, or null when the document is ready. */
export const createBlocker = (draft: GatepassDraft, partyId: string): string | null => {
  if (!partyId) return copy.gatepass.blockerParty;
  if (draft.errorCount > 0) return copy.gatepass.blockerErrors;
  if (draft.lines.length === 0) return copy.gatepass.blockerLines;
  return null;
};

export const articleLabel = (article: Pick<DraftArticle, "article" | "size" | "groupName">): string =>
  `${articleWithGroup(article.article, article.groupName)} · ${article.size}`;

/** "SK6-7/10": safe for DOM ids and test ids (the grid key itself carries a NUL separator). */
export const articleSlug = (article: Pick<DraftArticle, "article" | "size">): string => `${article.article}-${article.size}`.replace(/[^\w/.-]+/g, "-");

export interface ArticleOption {
  id: string;
  label: string;
}

/** Every article + size the store holds, for the Add Article search — just the name and size. */
export const listArticleOptions = (grid: StockGrid): ArticleOption[] =>
  grid.rows.map((row) => ({ id: row.key, label: articleLabel(row) }));
