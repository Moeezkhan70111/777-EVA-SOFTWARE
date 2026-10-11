// Dana issued out of the store FOR a machine program.
//
//   MP-000008 runs a BLACK sole  ->  which BLACK Danas does the store hold?
//                                ->  50 KG of EVA BLACK leaves, stamped MP-000008
//
// Dana is what a sole is MOULDED FROM, and a program has never reserved it: there is no
// allocation to consume and no outstanding quantity, only "this program runs these sole
// colours, and today this much went out for it". That is why nothing here looks at
// machine_program_upper_lines and nothing here computes a remaining figure.
//
// Dana is never labelled (owner, 2026-10-11): it comes in loose and goes out by a TYPED QUANTITY,
// in its own unit — KG, or any unit on its ladder (BAG when "1 BAG = 25 KG" is set). There is no
// bag size to configure first and no stock shown first: the operator types what is going out.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
//
// THE ISSUE ITSELF IS NOT WRITTEN HERE. It goes through moveRawMaterialByHand — the one path a
// typed quantity leaves the raw material store by — so Dana Issue inherits every rule that
// already guards it: the unit conversion along the material's ladder, the refusal of more than
// the store holds, and the refusal of a material whose packets carry labels (which are scanned).

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { MachineProgramDanaOption, RawMaterialHandMoveResult } from "./types.js";
import { RAW_MATERIAL_KIND, attributeKey, roundQuantity } from "@erp/domain";
import { COLOUR_SQL, KIND_JOINS, KIND_SQL } from "./machineProgramSql.js";

const text = (value: unknown): string => (value == null ? "" : String(value));

export const machineProgramDanaMethods = {
  /**
   * Every Dana the store holds in the SOLE COLOURS this program runs, with the units it can be
   * issued in.
   *
   * The colours come from the program's own runs, so a program that moulds only BLACK soles
   * offers only BLACK Dana — the upper colours on it are not Dana and are deliberately not
   * offered (owner, 2026-10-11).
   *
   * One row per MATERIAL, never per colour: the store can hold EVA BLACK and PVC BLACK at once,
   * and "50 KG of BLACK" would not say which left. The operator picks the material.
   */
  listMachineProgramDanaOptions(this: SqliteDatabase, programId: string): MachineProgramDanaOption[] {
    const program = this.getMachineProgram(text(programId).trim());
    if (!program) return [];

    const colours = [...new Set(program.runs.map((run) => attributeKey(run.soleColour)).filter(Boolean))];
    if (colours.length === 0) return [];

    const placeholders = colours.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ii.id, ii.display_name, ic.name AS sub_category_name, ${COLOUR_SQL} AS colour
           FROM inventory_items ii
           ${KIND_JOINS}
           JOIN inventory_categories ic ON ic.id = ii.category_id
          WHERE ii.status = 'ACTIVE' AND ${KIND_SQL} = ?
            AND UPPER(TRIM(${COLOUR_SQL})) IN (${placeholders})
          ORDER BY UPPER(TRIM(${COLOUR_SQL})), ii.display_name`
      )
      .all(RAW_MATERIAL_KIND.DANA, ...colours) as Array<Record<string, unknown>>;

    // How much of each Dana has gone out for THIS program so far: its stock movements stamped with
    // the program (migration 065). They are kept in the material's stock unit and are negative as
    // they leave, so the sum turned round is what was issued — net of anything that came back.
    const issued = new Map(
      (this.db
        .prepare(
          `SELECT item_id, -SUM(quantity) AS issued FROM inventory_stock_events
            WHERE machine_program_id = ? GROUP BY item_id`
        )
        .all(program.id) as Array<{ item_id: string; issued: number }>).map((row) => [text(row.item_id), Number(row.issued ?? 0)])
    );

    return rows.map((row) => {
      const itemId = text(row.id);
      // The same units and refusals the Move Out by Hand panel works from, so the two can never
      // disagree about what a quantity of this Dana means.
      const options = this.getRawMaterialHandMoveOptions(itemId, "OUT");
      return {
        itemId,
        displayName: text(row.display_name),
        colour: attributeKey(text(row.colour)),
        subCategoryName: text(row.sub_category_name),
        units: options?.units ?? [],
        stockUnitCode: options?.stockUnitCode ?? null,
        issuedQuantity: roundQuantity(issued.get(itemId) ?? 0),
        blockedReason: options?.blockedReason ?? null,
      };
    });
  },

  /**
   * Issues a typed quantity of one Dana out of the store for a program.
   *
   * The movement is handed to moveRawMaterialByHand so there is exactly one place a typed
   * quantity leaves the raw material store — it converts the unit and refuses more than is
   * there. The program id rides along and is stamped on the stock event (migration 065), which is
   * what makes the issue traceable to this document.
   */
  issueMachineProgramDana(
    this: SqliteDatabase,
    input: { programId: string; itemId: string; quantity: number; unitCode: string; actor?: string | null }
  ): RawMaterialHandMoveResult {
    const refuse = (outcome: RawMaterialHandMoveResult["outcome"], reason: string): RawMaterialHandMoveResult => ({
      accepted: false,
      outcome,
      reason,
    });

    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return refuse("INVALID_QUANTITY", "Type how much Dana is going out — a number above 0.");
    }

    const program = this.getMachineProgram(text(input.programId).trim());
    if (!program) return refuse("NOT_FOUND", "This machine program no longer exists.");
    if (this.isMachineProgramClosed(program.id)) {
      return refuse("NOT_ELIGIBLE", `${program.code} is closed — production is complete, so no more Dana goes out for it.`);
    }
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
    if (!option.stockUnitCode) {
      return refuse("NOT_ELIGIBLE", `${option.displayName} has no stock in the store yet. Move it in by hand on Store In first.`);
    }
    const unitCode = text(input.unitCode).trim().toUpperCase() || option.stockUnitCode;

    return this.moveRawMaterialByHand({
      itemId: option.itemId,
      direction: "OUT",
      quantity,
      unitCode,
      note: `Dana for ${program.code} — ${quantity} ${unitCode}`,
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
