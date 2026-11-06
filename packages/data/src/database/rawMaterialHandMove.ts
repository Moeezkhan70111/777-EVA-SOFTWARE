// Moving raw material in and out of the store BY HAND, for stock that carries no label.
//
// Most material leaves by being scanned: a packet has a QR, the scan knows what it holds, and
// the balance follows. Nawaar on a roll has no label on it — the storekeeper cuts what the
// floor asks for — so the only way to take it out is to say what went: "700 INCH of this
// nawaar", or "1 RULE", which for a 975-inch rule is the same move said in bigger words.
//
// Two rules make that safe, and both are enforced HERE rather than in the screen:
//
//   1. The quantity is converted through the material's OWN ladder (@erp/domain unitLadder),
//      never through the global conversion table. "1 RULE = 975 INCH" is a fact about this
//      nawaar, not about rules and inches.
//   2. A material that still has LABELLED packets in the store cannot go out this way. The
//      balance and the packet count are kept separately, so taking a quantity off the balance
//      while its packets still read IN_STORE would leave the two disagreeing with nothing to
//      say which is right. Scan those packets out instead.
//
// This is a MOVEMENT, not a correction: the store is not saying the system is wrong, it is
// saying material left. So it applies immediately and needs nobody's approval — the same as a
// scan — and is recorded as a TRANSFER_OUT stock event naming the operator and what they typed.
// A claim that the balance itself is wrong is a stock correction (stockCorrections.ts), which
// is a different act and does need an administrator.
//
// Machine programs are deliberately left alone. A program reserves an upper, uppers always
// carry labels, and crediting an unidentified quantity to a program would be a guess about who
// it was for.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import { STOCK_EVENT_NOTE, convertOnLadder, isRawMaterialReceiptPartyType, unitsForCount, type UnitLadderStep } from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { HandMoveDirection, RawMaterialHandMoveInput, RawMaterialHandMoveOptions, RawMaterialHandMoveResult } from "./types.js";

/** Quantities are stored as REAL; three decimals is the most any unit in use needs. */
const round = (value: number): number => Number(value.toFixed(3));

const refuse = (outcome: RawMaterialHandMoveResult["outcome"], reason: string): RawMaterialHandMoveResult => ({
  accepted: false,
  outcome,
  reason,
});

export const rawMaterialHandMoveMethods = {
  /**
   * What the Store In / Move Out screens need to offer one material: the units it may be
   * counted in, what is on the shelf, and whether it may be moved by hand in that direction.
   *
   * One read for both directions, because everything except the refusal is the same fact
   * about the material. The screen shows `blockedReason` and hides the form; the write checks
   * the same thing again, because a hidden form is not a rule (R9).
   */
  getRawMaterialHandMoveOptions(this: SqliteDatabase, itemId: string, direction: HandMoveDirection = "OUT"): RawMaterialHandMoveOptions | null {
    const id = String(itemId ?? "").trim();
    if (!id) return null;

    const item = this.db
      .prepare(
        `SELECT ii.id, ii.item_code, ii.display_name, ii.status,
                COALESCE(isb.quantity_on_hand, 0) AS quantity_on_hand
         FROM inventory_items ii
         LEFT JOIN inventory_stock_balances isb ON isb.item_id = ii.id
         WHERE ii.id = ? LIMIT 1`
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!item) return null;

    const ladder = this.getInventoryItemUnitLadder(id);
    const steps: UnitLadderStep[] = ladder.steps.map((step) => ({ fromUnit: step.fromUnit, toUnit: step.toUnit, factor: step.factor }));
    const labelledPackets = this.labelledRawMaterialPackets(this.db, id).get(id)?.packets ?? 0;
    const active = String(item.status ?? "ACTIVE") === "ACTIVE";

    return {
      itemId: id,
      itemCode: String(item.item_code ?? ""),
      displayName: String(item.display_name ?? ""),
      stockUnitCode: ladder.stockUnit,
      stockUnitId: ladder.stockUnitId,
      quantityOnHand: round(Number(item.quantity_on_hand ?? 0)),
      units: unitsForCount(steps, ladder.stockUnit),
      steps: ladder.steps,
      labelledPacketsInStore: labelledPackets,
      blockedReason: handMoveBlockedReason({ direction, active, stockUnit: ladder.stockUnit, labelledPackets }),
    };
  },

  /**
   * Moves a typed quantity on or off a material's balance and records that it came in or left.
   *
   * Every refusal comes back as an outcome with a sentence the storekeeper can act on, and
   * nothing is written unless the whole thing is sound.
   */
  moveRawMaterialByHand(this: SqliteDatabase, input: RawMaterialHandMoveInput): RawMaterialHandMoveResult {
    const direction: HandMoveDirection = input.direction === "IN" ? "IN" : "OUT";
    const options = this.getRawMaterialHandMoveOptions(String(input.itemId ?? ""), direction);
    if (!options) return refuse("NOT_FOUND", "This raw material is no longer in the master.");
    if (options.blockedReason) {
      return refuse(options.labelledPacketsInStore > 0 && direction === "OUT" ? "HAS_LABELLED_PACKETS" : "NOT_ELIGIBLE", options.blockedReason);
    }

    const stockUnit = options.stockUnitCode;
    const stockUnitId = options.stockUnitId;
    if (!stockUnit || !stockUnitId) return refuse("NOT_ELIGIBLE", "This material has no stock unit yet, so nothing can be moved on it.");

    // Receiving is supplier-at-a-time, the same rule a scanning session follows: material that
    // arrives has to name whoever delivered it, label or no label.
    let partyId: string | null = null;
    if (direction === "IN") {
      partyId = String(input.partyId ?? "").trim() || null;
      if (!partyId) return refuse("NO_SUPPLIER", "Choose the supplier this delivery came from.");
      const party = this.db
        .prepare("SELECT id, party_name, party_type FROM parties WHERE id = ? AND deleted_at IS NULL LIMIT 1")
        .get(partyId) as { id: string; party_name: string; party_type: string } | undefined;
      if (!party) return refuse("NO_SUPPLIER", "That supplier is not in the Party Master.");
      if (!isRawMaterialReceiptPartyType(party.party_type)) {
        return refuse("NO_SUPPLIER", `Only a supplier's delivery is moved in, and ${party.party_name} is not a supplier. Nothing was moved.`);
      }
    }

    const typedUnit = String(input.unitCode ?? "").trim().toUpperCase();
    if (!options.units.includes(typedUnit)) {
      return refuse("UNKNOWN_UNIT", `${typedUnit || "That unit"} is not one of the units this material is counted in.`);
    }

    const typed = Number(input.quantity);
    if (!Number.isFinite(typed) || typed <= 0) {
      return refuse("INVALID_QUANTITY", direction === "IN" ? "Type how much came in — a number above 0." : "Type how much is going out — a number above 0.");
    }

    // The material's OWN ladder, never the global conversion table: 1 RULE = 975 INCH is a
    // fact about this nawaar.
    const steps: UnitLadderStep[] = options.steps.map((step) => ({ fromUnit: step.fromUnit, toUnit: step.toUnit, factor: step.factor }));
    const inStockUnit = typedUnit === stockUnit ? typed : convertOnLadder(steps, typed, typedUnit, stockUnit);
    if (inStockUnit == null || !Number.isFinite(inStockUnit) || inStockUnit <= 0) {
      return refuse("UNKNOWN_UNIT", `${typedUnit} cannot be turned into ${stockUnit} for this material. Check its unit ladder.`);
    }

    const moving = round(inStockUnit);
    if (direction === "OUT" && moving > options.quantityOnHand) {
      return refuse(
        "NOT_ENOUGH_STOCK",
        `Only ${options.quantityOnHand} ${stockUnit} is in the store. ${round(typed)} ${typedUnit} is ${moving} ${stockUnit}.`
      );
    }

    const typedNote = String(input.note ?? "").trim();
    // Stock leaving by hand has no label and no scan to say where it went, so the operator has
    // to (owner request, 0.3.6). Checked last, after every rule about the amount, so a move that
    // is wrong in two ways is refused for the more basic one first. Dana issues always carry
    // their program in the note, so this never stops one.
    if (direction === "OUT" && typedNote === "") {
      return refuse("NO_PURPOSE", "Say what this is going out for — e.g. cutting table.");
    }
    // What the operator typed is kept word for word beside what it came to, so the ledger can
    // be read back without redoing the arithmetic.
    const what = direction === "IN" ? STOCK_EVENT_NOTE.MANUAL_IN : STOCK_EVENT_NOTE.MANUAL_OUT;
    const note = [`${what} — ${round(typed)} ${typedUnit}`, typedNote].filter(Boolean).join(" · ");

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const applied = this.applyInventoryStockChange({
        itemId: options.itemId,
        quantity: direction === "IN" ? moving : -moving,
        eventType: direction === "IN" ? "RECEIVE" : "TRANSFER_OUT",
        unitId: stockUnitId,
        note,
        createdBy: input.actor ? String(input.actor) : undefined,
        partyId,
        machineProgramId: input.machineProgramId ?? null,
      });
      this.db.exec("COMMIT");
      return {
        accepted: true,
        outcome: "MOVED",
        direction,
        quantity: moving,
        unitCode: stockUnit,
        typedQuantity: round(typed),
        typedUnitCode: typedUnit,
        quantityOnHand: round(applied.quantityOnHand),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      return refuse("NOT_ENOUGH_STOCK", error instanceof Error ? error.message : "The move could not be saved. Nothing was changed.");
    }
  },
};

/** Why this material cannot be moved by hand in this direction, or null when it can. */
const handMoveBlockedReason = (input: {
  direction: HandMoveDirection;
  active: boolean;
  stockUnit: string | null;
  labelledPackets: number;
}): string | null => {
  if (!input.active) return "This material has been retired, so nothing can be moved on it.";
  if (!input.stockUnit) return "This material has no stock unit yet. Set it on Stock before moving any by hand.";
  // Only OUT is blocked. Taking a quantity off the balance while its packets still read
  // IN_STORE leaves the two disagreeing with nothing to say which is right. Adding loose stock
  // creates no such contradiction — the store simply holds labelled packets and a loose
  // remainder, which is how a balance is already read (domain packetsInStore).
  if (input.direction === "OUT" && input.labelledPackets > 0) {
    const packets = input.labelledPackets === 1 ? "1 labelled packet" : `${input.labelledPackets} labelled packets`;
    return `${packets} of this material are in the store. Scan them out on the right instead — moving it by hand here would leave the balance and the packets disagreeing.`;
  }
  return null;
};

export type RawMaterialHandMoveMethods = typeof rawMaterialHandMoveMethods;
