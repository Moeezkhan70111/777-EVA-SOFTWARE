import { fromPaisa, toPaisa, typedRupeesToPaisa } from "@erp/domain";
import { copy } from "../../config/copy";

// THE DISCOUNT POLICY PAGE'S RULES (owner, 28 Nov 2026: "the discount page is not following our rules, style and guides
// and laws"). Pure: the screen asks here what a customer's discount is now, what was typed, and what will be saved.
//
// Every box starts with the customer's CURRENT discount (recognition over recall: no remembering, no looking it up in
// the report). A box changed from it is a change; Save sends only the changes. Typed loosely ("1,000", " 35 ") and
// kept exactly, in paisa (Postel, R15). An emptied box that had a discount is said to need 0: a discount is taken off
// by giving it 0, and nothing is removed by an empty box.

export const DISCOUNT_KIND = {
  PRODUCT_GROUP: "PRODUCT_GROUP",
  ARTICLE_SERIES: "ARTICLE_SERIES",
  ARTICLE: "ARTICLE",
  PRICE_RANGE: "PRICE_RANGE",
} as const;
export type DiscountKind = (typeof DISCOUNT_KIND)[keyof typeof DISCOUNT_KIND];
export const DISCOUNT_KINDS: readonly DiscountKind[] = Object.values(DISCOUNT_KIND);

export const SIZE_SCOPE = { ALL_SIZES: "ALL_SIZES", SEPARATE_SIZES: "SEPARATE_SIZES" } as const;
export type SizeScope = (typeof SIZE_SCOPE)[keyof typeof SIZE_SCOPE];

/** One line of the main process's discount report (getPartyDiscountReport). */
export interface DiscountReportLine {
  readonly partyId: string;
  readonly partyName: string;
  readonly type: string;
  readonly label: string;
  /** Rupees per pair. */
  readonly discountPerPair: number;
}

/** The label the report gives an article rule: "SK6", or "SK6 / Size 7/10" for one size. */
export const articleLabel = (article: string, size: string | null): string => (size ? `${article} / Size ${size}` : article);

/** The key of one box: a customer, and a size when the discount is per size. */
export const cellKey = (partyId: string, size = ""): string => `${partyId}\u0000${size}`;

/** Each customer's current discount, in paisa, for one thing (its report label), by box. */
export function currentDiscounts(report: readonly DiscountReportLine[], kind: DiscountKind, labels: ReadonlyMap<string, string>): Map<string, number> {
  const current = new Map<string, number>();
  for (const line of report) {
    if (line.type !== kind) continue;
    for (const [size, label] of labels) if (line.label === label) current.set(cellKey(line.partyId, size), toPaisa(line.discountPerPair));
  }
  return current;
}

/** A discount on screen: whole rupees, or with paisa when it has some. */
export const discountText = (paisa: number): string => (paisa % 100 === 0 ? String(paisa / 100) : fromPaisa(paisa).toFixed(2));

export interface DiscountChange {
  readonly key: string;
  readonly partyId: string;
  readonly size: string;
  /** Rupees per pair, as the save calls take it. */
  readonly rupees: number;
}

/** What one box says now: the typed text when it was touched, else the current discount. */
export const boxText = (key: string, drafts: Readonly<Record<string, string>>, current: ReadonlyMap<string, number>): string => {
  if (key in drafts) return drafts[key] ?? "";
  const paisa = current.get(key);
  return paisa === undefined ? "" : discountText(paisa);
};

/** Why a typed box cannot be saved, or null. */
export function boxProblem(typed: string, currentPaisa: number | undefined): string | null {
  const text = typed.trim().replace(/,/g, "");
  if (text === "") return currentPaisa !== undefined && currentPaisa > 0 ? copy.discountPolicy.typeZero : null;
  return typedRupeesToPaisa(text) === null ? copy.discountPolicy.notAnAmount : null;
}

/** The boxes changed from their current discount and valid, and the problems of the others, by box. */
export function discountChanges(drafts: Readonly<Record<string, string>>, current: ReadonlyMap<string, number>): { changes: DiscountChange[]; problems: Map<string, string> } {
  const changes: DiscountChange[] = [];
  const problems = new Map<string, string>();
  for (const [key, typed] of Object.entries(drafts)) {
    const was = current.get(key);
    const problem = boxProblem(typed, was);
    if (problem) { problems.set(key, problem); continue; }
    const paisa = typedRupeesToPaisa(typed.trim().replace(/,/g, ""));
    if (paisa === null || paisa === (was ?? null)) continue;
    if (was === undefined && paisa === 0) continue;
    const [partyId = "", size = ""] = key.split("\u0000");
    changes.push({ key, partyId, size, rupees: fromPaisa(paisa) });
  }
  return { changes, problems };
}

/** The report lines a type filter keeps ("ALL" keeps every kind), with no discount left out. */
export const reportLinesFor = (report: readonly DiscountReportLine[], filter: DiscountKind | "ALL"): DiscountReportLine[] =>
  report.filter((line) => line.discountPerPair > 0 && (filter === "ALL" || line.type === filter));
