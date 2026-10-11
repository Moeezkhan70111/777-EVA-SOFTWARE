// Dana issued out of the store FOR a machine program.
//
//   MP-000008 runs a BLACK sole  ->  which BLACK Danas does the store hold?
//                                ->  3 BAGS of EVA BLACK leave, stamped MP-000008
//
// Dana is what a sole is MOULDED FROM, and a program has never reserved it: there is no
// allocation to consume and no outstanding quantity, only "this program runs these sole
// colours, and today these bags went out for it". That is why nothing here looks at
// machine_program_upper_lines and nothing here computes a remaining figure.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
//
// THE ISSUE ITSELF IS NOT WRITTEN HERE. It goes through moveRawMaterialByHand — the one path a
// typed quantity leaves the raw material store by — so Dana Issue inherits every rule that
// already guards it, including the one that matters most: a material with LABELLED PACKETS in
// the store cannot go out by typing a count, because the balance and the packets would then
// disagree with nothing to say which is right. Those bags are scanned out instead.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { MachineProgramDanaOption, RawMaterialHandMoveResult } from "./types.js";
import { RAW_MATERIAL_KIND, attributeKey, bagsFromBalance } from "@erp/domain";
import { EFFECTIVE_PACK_NAME_SQL } from "./shared.js";
import { COLOUR_SQL, KIND_JOINS, KIND_SQL } from "./machineProgramSql.js";

const text = (value: unknown): string => (value == null ? "" : String(value));

export const machineProgramDanaMethods = {
  /**
   * Every Dana the store holds in the SOLE COLOURS this program runs.
   *
   * The colours come from the program's own runs, so a program that moulds only BLACK soles
   * offers only BLACK Dana — the upper colours on it are not Dana and are deliberately not
   * offered (owner, 2026-10-11).
   *
   * One row per MATERIAL, never per colour: the store can hold EVA BLACK and PVC BLACK at once,
   * and "3 bags of BLACK" would not say which left. The operator picks the material.
   */
  listMachineProgramDanaOptions(this: SqliteDatabase, programId: string): MachineProgramDanaOption[] {
    const program = this.getMachineProgram(text(programId).trim());
    if (!program) return [];

    const colours = [...new Set(program.runs.map((run) => attributeKey(run.soleColour)).filter(Boolean))];
    if (colours.length === 0) return [];

    const placeholders = colours.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ii.id, ii.display_name, ii.packing_quantity, ii.packing_unit_id,
                ic.name AS sub_category_name, ${EFFECTIVE_PACK_NAME_SQL} AS pack_name,
                ${COLOUR_SQL} AS colour,
                pu.code AS packing_unit_code,
                b.quantity_on_hand, b.unit_id AS stock_unit_id,
                su.code AS stock_unit_code
           FROM inventory_items ii
           ${KIND_JOINS}
           JOIN inventory_categories ic ON ic.id = ii.category_id
           LEFT JOIN inventory_units pu ON pu.id = ii.packing_unit_id
           LEFT JOIN inventory_stock_balances b ON b.item_id = ii.id
           LEFT JOIN inventory_units su ON su.id = b.unit_id
          WHERE ii.status = 'ACTIVE' AND ${KIND_SQL} = ?
            AND UPPER(TRIM(${COLOUR_SQL})) IN (${placeholders})
          ORDER BY UPPER(TRIM(${COLOUR_SQL})), ii.display_name`
      )
      .all(RAW_MATERIAL_KIND.DANA, ...colours) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const itemId = text(row.id);
      const quantityOnHand = Number(row.quantity_on_hand ?? 0);
      const packSize = this.packSizeInStockUnit(
        row.packing_quantity == null ? null : Number(row.packing_quantity),
        row.packing_unit_id ? text(row.packing_unit_id) : null,
        row.stock_unit_id ? text(row.stock_unit_id) : null
      );
      // The same refusals the Move Out by Hand panel shows, read here so the screen can grey the
      // row and say why BEFORE the operator types a number into it.
      const options = this.getRawMaterialHandMoveOptions(itemId, "OUT");
      return {
        itemId,
        displayName: text(row.display_name),
        colour: attributeKey(text(row.colour)),
        subCategoryName: text(row.sub_category_name),
        packName: text(row.pack_name).trim().toUpperCase() || "BAG",
        /** One bag expressed in the unit stock is counted in, or null when it has no packing. */
        packSize,
        packingUnitCode: row.packing_unit_code ? text(row.packing_unit_code) : null,
        stockUnitCode: row.stock_unit_code ? text(row.stock_unit_code) : null,
        quantityOnHand,
        /** Whole bags on the shelf. A part bag is not a bag anybody can carry, so it is floored. */
        bagsOnHand: bagsFromBalance(quantityOnHand, packSize),
        blockedReason: options?.blockedReason ?? null,
      };
    });
  },

  /**
   * Issues whole bags of one Dana out of the store for a program.
   *
   * Bags are turned into the material's own quantity HERE, where the pack size lives, and the
   * movement itself is handed to moveRawMaterialByHand so there is exactly one place a typed
   * quantity leaves the raw material store. The program id rides along and is stamped on the
   * stock event (migration 065), which is what makes the issue traceable to this document.
   */
  issueMachineProgramDana(
    this: SqliteDatabase,
    input: { programId: string; itemId: string; bags: number; actor?: string | null }
  ): RawMaterialHandMoveResult {
    const refuse = (outcome: RawMaterialHandMoveResult["outcome"], reason: string): RawMaterialHandMoveResult => ({
      accepted: false,
      outcome,
      reason,
    });

    const bags = Number(input.bags);
    if (!Number.isInteger(bags) || bags <= 0) {
      return refuse("INVALID_QUANTITY", "Type how many bags are going out — a whole number above 0.");
    }

    const program = this.getMachineProgram(text(input.programId).trim());
    if (!program) return refuse("NOT_FOUND", "This machine program no longer exists.");
    if (program.status === "CANCELLED") {
      return refuse("NOT_ELIGIBLE", `${program.code} has been deleted. Nothing can be issued against it.`);
    }

    // The material has to be a Dana of a sole colour this program actually runs — the screen
    // offers nothing else, and this is what makes that true rather than merely displayed.
    const option = this.listMachineProgramDanaOptions(program.id).find((row) => row.itemId === text(input.itemId).trim());
    if (!option) {
      return refuse("NOT_ELIGIBLE", `That Dana is not one of the sole colours ${program.code} runs.`);
    }
    if (option.blockedReason) return refuse("HAS_LABELLED_PACKETS", option.blockedReason);
    if (option.packSize == null || option.packSize <= 0) {
      return refuse("NOT_ELIGIBLE", `Set how much one ${option.packName} of ${option.displayName} holds before issuing it.`);
    }
    if (!option.stockUnitCode) {
      return refuse("NOT_ELIGIBLE", `${option.displayName} has no stock in the store yet.`);
    }

    return this.moveRawMaterialByHand({
      itemId: option.itemId,
      direction: "OUT",
      quantity: bags * option.packSize,
      unitCode: option.stockUnitCode,
      note: `Dana for ${program.code} — ${bags} ${option.packName}${bags === 1 ? "" : "S"}`,
      actor: input.actor ?? null,
      machineProgramId: program.id,
    });
  },

  /** Every Dana issue made for a program, newest first — the audit trail under the section. */
  listMachineProgramDanaIssues(
    this: SqliteDatabase,
    programId: string
  ): Array<{ itemId: string; displayName: string; quantity: number; unitCode: string | null; note: string | null; actor: string | null; issuedAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT e.item_id, ii.display_name, e.quantity, u.code AS unit_code, e.note, e.created_by, e.created_at
           FROM inventory_stock_events e
           JOIN inventory_items ii ON ii.id = e.item_id
           LEFT JOIN inventory_units u ON u.id = e.unit_id
          WHERE e.machine_program_id = ?
          ORDER BY e.created_at DESC, e.rowid DESC`
      )
      .all(text(programId).trim()) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      itemId: text(row.item_id),
      displayName: text(row.display_name),
      // Stored negative because it left the store; the screen reads "3 BAGS out", not "−75".
      quantity: Math.abs(Number(row.quantity ?? 0)),
      unitCode: row.unit_code ? text(row.unit_code) : null,
      note: row.note ? text(row.note) : null,
      actor: row.created_by ? text(row.created_by) : null,
      issuedAt: text(row.created_at),
    }));
  },
};

export type MachineProgramDanaMethods = typeof machineProgramDanaMethods;
