// Machine Program — the stock a program is cut against: the colours a sole can be moulded in,
// the Dana behind each colour, and the uppers that fit an article + size.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
//
// Nothing here is a second stock system. Physical is the authoritative balance
// (inventory_stock_balances). The supplier split comes from the labelled packets standing in the
// store (raw_material_qrs.party_id) and only ATTRIBUTES that balance — the part no label accounts
// for is reported as stock with no supplier recorded, never given to somebody.

import type { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { TransactionContext } from "@erp/application";
import { RAW_MATERIAL_KIND, RAW_MATERIAL_QR_STATUS, attributeKey, maxNewAllocation, roundQuantity } from "@erp/domain";
import type { MutableTransactionContext } from "./shared.js";
import { EFFECTIVE_PACK_NAME_SQL } from "./shared.js";
import {
  ARTICLE_SQL,
  COLOUR_SQL,
  KIND_JOINS,
  KIND_SQL,
  RESERVED_FOR_ITEM_SQL,
  RESERVED_FOR_SUPPLIER_SQL,
  RESERVED_UNATTRIBUTED_SQL,
  SIZE_SQL,
  TYPE_SQL,
} from "./machineProgramSql.js";
import type { MachineProgramMaterial, MachineProgramStockSource, SoleColourOption } from "./types.js";

/** Whether a machine may be programmed with a material, and why not when it may not. */
interface ProgramAllocability {
  allocatable: boolean;
  notAllocatableReason: string | null;
}

/** What one supplier's labelled packets of a material hold, in the material's stock unit. */
interface LabelledSupplierStock {
  partyId: string;
  partyName: string;
  packets: number;
  contents: number;
}

/** The figures a save re-reads inside its write lock — nothing from the screen is trusted. */
export interface UpperAvailability {
  itemId: string;
  displayName: string;
  kind: string;
  article: string;
  size: string;
  unitId: string | null;
  unitCode: string | null;
  itemPhysical: number;
  itemReserved: number;
  itemAvailable: number;
  allocatable: boolean;
  notAllocatableReason: string | null;
}

const MATERIAL_SELECT = `SELECT ii.id, ii.item_code, ii.display_name, ii.status, ${EFFECTIVE_PACK_NAME_SQL} AS pack_name,
         COALESCE(isb.unit_id, ii.default_unit_id) AS stock_unit_id, su.code AS stock_unit_code,
         COALESCE(isb.quantity_on_hand, 0) AS quantity_on_hand,
         kind_cat.name AS category_name, kind_parent.name AS parent_category_name, ${KIND_SQL} AS kind,
         ${COLOUR_SQL} AS colour, ${TYPE_SQL} AS type, ${ARTICLE_SQL} AS article, ${SIZE_SQL} AS size
  FROM inventory_items ii
  ${KIND_JOINS}
  LEFT JOIN inventory_stock_balances isb ON isb.item_id = ii.id
  LEFT JOIN inventory_units su ON su.id = COALESCE(isb.unit_id, ii.default_unit_id)`;

const text = (value: unknown): string => (value == null ? "" : String(value));

export const machineProgramStockMethods = {
  /**
   * The colours a sole can be moulded in.
   *
   * A sole is moulded from Dana, so the colours are the colours of the DANA in the Raw Material
   * Master, each with how much of it the store holds. When the store has no Dana set up at all,
   * every colour the store knows is offered instead — so a program can still be written, and the
   * Dana step says plainly that there is none.
   */
  listSoleColourOptions(this: SqliteDatabase): SoleColourOption[] {
    const dana = this.db
      .prepare(
        `SELECT UPPER(TRIM(${COLOUR_SQL})) AS colour, COALESCE(isb.quantity_on_hand, 0) AS quantity, su.code AS unit_code
         FROM inventory_items ii
         ${KIND_JOINS}
         LEFT JOIN inventory_stock_balances isb ON isb.item_id = ii.id
         LEFT JOIN inventory_units su ON su.id = COALESCE(isb.unit_id, ii.default_unit_id)
         WHERE ii.status = 'ACTIVE' AND ${KIND_SQL} = ?`
      )
      .all(RAW_MATERIAL_KIND.DANA) as Array<Record<string, unknown>>;

    const byColour = new Map<string, SoleColourOption>();
    for (const row of dana) {
      const colour = text(row.colour);
      if (!colour) continue;
      const current = byColour.get(colour);
      const unitCode = row.unit_code ? text(row.unit_code) : null;
      if (!current) {
        byColour.set(colour, { colour, hasDana: true, danaQuantity: roundQuantity(Number(row.quantity ?? 0)), danaUnitCode: unitCode });
        continue;
      }
      // Two Dana materials of one colour add up only when they are counted in the same unit.
      const sameUnit = current.danaUnitCode === unitCode && current.danaQuantity != null;
      current.danaQuantity = sameUnit ? roundQuantity((current.danaQuantity ?? 0) + Number(row.quantity ?? 0)) : null;
    }
    if (byColour.size > 0) return [...byColour.values()].sort((a, b) => a.colour.localeCompare(b.colour));

    const known = this.db
      .prepare(
        `SELECT DISTINCT UPPER(TRIM(${COLOUR_SQL})) AS colour FROM inventory_items ii WHERE ii.status = 'ACTIVE'`
      )
      .all() as Array<Record<string, unknown>>;
    return known
      .map((row) => text(row.colour))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .map((colour) => ({ colour, hasDana: false, danaQuantity: null, danaUnitCode: null }));
  },

  /** Whether a colour is one this store knows, so a saved run never names a colour from nowhere. */
  isKnownSoleColour(this: SqliteDatabase, colour: string): boolean {
    const wanted = attributeKey(colour);
    return wanted !== "" && this.listSoleColourOptions().some((option) => option.colour === wanted);
  },

  /**
   * The Dana in one colour, supplier by supplier. Shown so the operator can see the sole can be
   * moulded — a program never reserves Dana, so its figures are simply what is in the store.
   */
  listMachineProgramDana(this: SqliteDatabase, colour: string): MachineProgramMaterial[] {
    const rows = this.db
      .prepare(`${MATERIAL_SELECT} WHERE ii.status = 'ACTIVE' AND ${KIND_SQL} = ? AND UPPER(TRIM(${COLOUR_SQL})) = ? ORDER BY ii.display_name`)
      .all(RAW_MATERIAL_KIND.DANA, attributeKey(colour)) as Array<Record<string, unknown>>;
    return rows
      .map((row) => this.buildProgramMaterial(row, null, this.db))
      .filter((material) => material.physical > 0);
  },

  /**
   * Every upper that fits one article + size from the Product Master — every colour of it the
   * store holds — with how much of each is still free for a new program.
   *
   * SK6 7/10 therefore answers with the BLACK, the GREEN and the BROWN SK6 7/10 uppers alike: the
   * colour of the upper is the operator's choice, not something the sole colour or the article
   * narrows. Matched EXACTLY on the upper's ARTICLE and SIZE attributes — trimmed and
   * upper-cased, never fuzzy. An upper with nothing in the store and nothing promised has nothing
   * to say and is left out; a fully promised one stays, because "none left" is the explanation
   * somebody needs.
   */
  listMachineProgramUppers(this: SqliteDatabase, machineId: string, articleSizeId: string): MachineProgramMaterial[] {
    const machine = this.db.prepare("SELECT section_id FROM machines WHERE id = ? LIMIT 1").get(text(machineId).trim()) as
      | { section_id: string }
      | undefined;
    const articleSize = this.db
      .prepare("SELECT article, size FROM article_sizes WHERE id = ? LIMIT 1")
      .get(text(articleSizeId).trim()) as { article: string; size: string } | undefined;
    if (!machine || !articleSize) return [];

    const rows = this.db
      .prepare(
        `${MATERIAL_SELECT}
         WHERE ii.status = 'ACTIVE' AND ${KIND_SQL} = ?
           AND UPPER(TRIM(${ARTICLE_SQL})) = ? AND UPPER(TRIM(${SIZE_SQL})) = ?
         ORDER BY UPPER(TRIM(${COLOUR_SQL})), ii.display_name`
      )
      .all(RAW_MATERIAL_KIND.UPPER, attributeKey(articleSize.article), attributeKey(articleSize.size)) as Array<Record<string, unknown>>;
    return rows
      .map((row) => this.buildProgramMaterial(row, machine.section_id, this.db))
      .filter((material) => material.physical > 0 || material.reserved > 0);
  },

  /** @internal One material as the program shows it. `machineSectionId` null = never allocatable (Dana). */
  buildProgramMaterial(
    this: SqliteDatabase,
    row: Record<string, unknown>,
    machineSectionId: string | null,
    db: DatabaseSync
  ): MachineProgramMaterial {
    const itemId = text(row.id);
    const physical = roundQuantity(Number(row.quantity_on_hand ?? 0));
    const reserved = roundQuantity(Number((db.prepare(`SELECT ${RESERVED_FOR_ITEM_SQL} AS r`).get(itemId, "") as { r: number }).r ?? 0));
    const available = maxNewAllocation(physical, reserved);
    const allocability: ProgramAllocability =
      machineSectionId == null
        ? { allocatable: false, notAllocatableReason: null }
        : this.machineProgramAllocability();

    return {
      itemId,
      itemCode: text(row.item_code),
      displayName: text(row.display_name),
      categoryPath: row.parent_category_name ? `${text(row.parent_category_name)} — ${text(row.category_name)}` : text(row.category_name),
      subCategoryName: text(row.category_name),
      colour: attributeKey(text(row.colour)),
      type: attributeKey(text(row.type)) || null,
      unitCode: row.stock_unit_code ? text(row.stock_unit_code) : null,
      packName: text(row.pack_name).trim() || "PACKET",
      physical,
      reserved,
      available,
      sources: this.programStockSources(itemId, physical, available, "", db),
      allocatable: allocability.allocatable,
      notAllocatableReason: allocability.notAllocatableReason,
    };
  },

  /**
   * @internal Whether this machine may be programmed with this material, and why not.
   *
   * A program reserves stock that will leave the STORE for this machine, so the material's first
   * material could only go on a machine the store already routed it to. Routes were removed on
   * 2026-10-07 — the store sends material wherever it is needed — so anything in stock can be
   * programmed. Kept as one function because the rule, if one returns, belongs in one place.
   */
  machineProgramAllocability(this: SqliteDatabase): ProgramAllocability {
    return { allocatable: true, notAllocatableReason: null };
  },

  /**
   * @internal A material's stock broken down by where it came from.
   *
   * Each supplier's labelled packets are their own source, never merged. What the balance holds
   * beyond every label is one more source with no supplier. Every source is capped by what the
   * material as a whole has free, so two suppliers can never between them promise more.
   */
  programStockSources(
    this: SqliteDatabase,
    itemId: string,
    physical: number,
    itemAvailable: number,
    excludeLineId: string,
    db: DatabaseSync
  ): MachineProgramStockSource[] {
    const labelled = this.labelledContentsBySupplier(itemId, db);
    const sources: MachineProgramStockSource[] = labelled.map((supplier) => {
      const reserved = Number(
        (db.prepare(`SELECT ${RESERVED_FOR_SUPPLIER_SQL} AS r`).get(itemId, excludeLineId, supplier.partyId) as { r: number }).r ?? 0
      );
      const sourcePhysical = roundQuantity(supplier.contents);
      return {
        supplierPartyId: supplier.partyId,
        supplierName: supplier.partyName,
        packets: supplier.packets,
        physical: sourcePhysical,
        reserved: roundQuantity(reserved),
        available: Math.min(maxNewAllocation(sourcePhysical, reserved), itemAvailable),
      };
    });

    // What no label accounts for. Negative would mean more labelled contents than the balance can
    // support — a stock question, not something to invent a supplier for — so it stays at zero.
    const unattributed = roundQuantity(Math.max(0, physical - labelled.reduce((sum, supplier) => sum + supplier.contents, 0)));
    const unattributedReserved = roundQuantity(
      Number((db.prepare(`SELECT ${RESERVED_UNATTRIBUTED_SQL} AS r`).get(itemId, excludeLineId) as { r: number }).r ?? 0)
    );
    if (unattributed > 0 || unattributedReserved > 0) {
      sources.push({
        supplierPartyId: null,
        supplierName: null,
        packets: null,
        physical: unattributed,
        reserved: unattributedReserved,
        available: Math.min(maxNewAllocation(unattributed, unattributedReserved), itemAvailable),
      });
    }
    return sources;
  },

  /** @internal What each supplier's labelled packets of one material hold, in its stock unit. */
  labelledContentsBySupplier(this: SqliteDatabase, itemId: string, db: DatabaseSync): LabelledSupplierStock[] {
    // Grouped by what the label says it holds, so a run of fifty identical labels is one row.
    const rows = db
      .prepare(
        `SELECT q.party_id, p.party_name,
                COALESCE(q.packing_quantity, ii.packing_quantity) AS quantity,
                COALESCE(q.packing_unit_id, ii.packing_unit_id) AS unit_id,
                COALESCE(isb.unit_id, ii.default_unit_id) AS stock_unit_id,
                COUNT(1) AS packets
         FROM raw_material_qrs q
         JOIN parties p ON p.id = q.party_id
         JOIN inventory_items ii ON ii.id = q.item_id
         LEFT JOIN inventory_stock_balances isb ON isb.item_id = q.item_id
         WHERE q.item_id = ? AND q.current_status = ? AND q.status <> 'VOID'
         GROUP BY q.party_id, p.party_name, quantity, unit_id, stock_unit_id
         ORDER BY p.party_name`
      )
      .all(itemId, RAW_MATERIAL_QR_STATUS.IN_STORE) as Array<Record<string, unknown>>;

    const bySupplier = new Map<string, LabelledSupplierStock>();
    for (const row of rows) {
      const partyId = text(row.party_id);
      const packets = Number(row.packets ?? 0);
      const each =
        this.packSizeInStockUnit(
          row.quantity == null ? null : Number(row.quantity),
          row.unit_id ? text(row.unit_id) : null,
          row.stock_unit_id ? text(row.stock_unit_id) : null
        ) ?? 0;
      const current = bySupplier.get(partyId) ?? { partyId, partyName: text(row.party_name), packets: 0, contents: 0 };
      bySupplier.set(partyId, { ...current, packets: current.packets + packets, contents: current.contents + each * packets });
    }
    return [...bySupplier.values()];
  },

  /**
   * The figures for exactly one upper, read inside the write lock — what the screen showed,
   * re-read so nothing stale is trusted. `excludeLineId` puts that line's own reservation back
   * first, so an edit is measured against what it already holds.
   *
   * One figure, for the material as a whole: a program no longer names the supplier a line is
   * taken from (2026-10-07), so what is free of the upper is the only ceiling there is.
   */
  async getMachineProgramUpperAvailability(
    this: SqliteDatabase,
    input: { itemId: string; machineSectionId: string; excludeLineId: string | null },
    tx: TransactionContext
  ): Promise<UpperAvailability | null> {
    const db = (tx as MutableTransactionContext).db;
    const row = db.prepare(`${MATERIAL_SELECT} WHERE ii.id = ? LIMIT 1`).get(text(input.itemId).trim()) as Record<string, unknown> | undefined;
    if (!row || text(row.status) !== "ACTIVE") return null;

    const itemId = text(row.id);
    const excludeLineId = text(input.excludeLineId);
    const itemPhysical = roundQuantity(Number(row.quantity_on_hand ?? 0));
    const itemReserved = roundQuantity(Number((db.prepare(`SELECT ${RESERVED_FOR_ITEM_SQL} AS r`).get(itemId, excludeLineId) as { r: number }).r ?? 0));
    const itemAvailable = maxNewAllocation(itemPhysical, itemReserved);
    const allocability: ProgramAllocability = this.machineProgramAllocability();

    return {
      itemId,
      displayName: text(row.display_name),
      kind: text(row.kind),
      article: text(row.article),
      size: text(row.size),
      unitId: row.stock_unit_id ? text(row.stock_unit_id) : null,
      unitCode: row.stock_unit_code ? text(row.stock_unit_code) : null,
      itemPhysical,
      itemReserved,
      itemAvailable,
      allocatable: allocability.allocatable,
      notAllocatableReason: allocability.notAllocatableReason,
    };
  },
};

export type MachineProgramStockMethods = typeof machineProgramStockMethods;
