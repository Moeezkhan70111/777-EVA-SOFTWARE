import { GATEPASS_STATUS } from "@erp/domain";
import type { Gatepass, GatepassStockRow } from "../../types/desktopApi";
import { dozensText } from "./gatepassDraft";

// EDITING A GATEPASS on the Gatepass screen (local migration 118): the pure rules the screen needs. Whether an edit is
// allowed is EditGatepassUseCase's to decide; these only decide what the screen offers and shows.

/** Whether to offer Edit: not deleted, Gatepass Issued or Billed, and nothing scanned out of the store yet. */
export const canEditGatepass = (document: Pick<Gatepass, "status" | "deletedAt" | "dispatchedFromStoreQuantity">): boolean =>
  !document.deletedAt &&
  (document.status === GATEPASS_STATUS.CREATED || document.status === GATEPASS_STATUS.BILLED) &&
  document.dispatchedFromStoreQuantity === 0;

/** A billed gatepass keeps its party: the bill is already the party's debt. */
export const partyIsLocked = (document: Pick<Gatepass, "status">): boolean => document.status !== GATEPASS_STATUS.CREATED;

/**
 * The store as an edit of this gatepass sees it: its own cartons given back -- what it issued directly returns to In
 * Store, what it still reserves leaves Reserved -- exactly as the edit does before it checks the new lines. Without
 * this, the screen would count the gatepass's cartons against its own edit.
 */
export const stockForEdit = (rows: readonly GatepassStockRow[], document: Pick<Gatepass, "lines">): GatepassStockRow[] => {
  const own = new Map(document.lines.map((line) => [line.productVariantId, line]));
  return rows.map((row) => {
    const line = own.get(row.productVariantId);
    if (!line) return row;
    const storeQuantity = row.storeQuantity + line.issuedDirectlyQuantity;
    const reservedQuantity = Math.max(0, row.reservedQuantity - line.outstandingQuantity);
    return { ...row, storeQuantity, reservedQuantity, reflectedQuantity: storeQuantity - reservedQuantity };
  });
};

/** The document's lines as the draft holds them: its articles in order (each with all its sizes), and the dozens per colour. */
export const draftFromDocument = (document: Pick<Gatepass, "lines">): { articles: string[]; inputs: Record<string, string> } => {
  const articles: string[] = [];
  const inputs: Record<string, string> = {};
  for (const line of document.lines) {
    if (!articles.includes(line.article)) articles.push(line.article);
    inputs[line.productVariantId] = dozensText(line.quantity);
  }
  return { articles, inputs };
};
