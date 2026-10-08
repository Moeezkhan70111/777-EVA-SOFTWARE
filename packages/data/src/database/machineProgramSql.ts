// The SQL fragments every Machine Program query is built from, in one place so "reserved" and
// "taken" can only ever mean one thing.
//
// Nothing here is cached. A line's consumption is recomputed from the events Raw Material Output
// stamped with it, and Reserved from the live programs' lines, every time it is asked for.

import { MACHINE_PROGRAM_STATUS, RAW_MATERIAL_ATTRIBUTE } from "@erp/domain";

/**
 * What Raw Material Output has taken for one upper line: every STORE_EXIT stamped with it, minus
 * every STORE_ENTRY carrying the same stamp (the compensating record written when a packet comes
 * back). The event's quantity is already in the material's stock unit — the scan converts it
 * before it touches the balance — so it adds up against the line's quantity directly.
 *
 * `mul` must be the machine_program_upper_lines alias in the enclosing query.
 */
export const LINE_CONSUMED_SQL = `(SELECT COALESCE(SUM(CASE rme.event_type
                                                  WHEN 'STORE_EXIT'  THEN rme.quantity
                                                  WHEN 'STORE_ENTRY' THEN -rme.quantity
                                                  ELSE 0 END), 0)
                            FROM raw_material_qr_events rme
                            WHERE rme.machine_program_upper_line_id = mul.id)`;

/**
 * Quantity still owed to live programs for one material, optionally narrowed to one supplier.
 *
 * Parameters, in order: itemId, the line to leave out ('' for none — an edit is measured
 * against the store with its own reservation put back), then the supplier when narrowed.
 */
const reservedSql = (supplierClause: string) =>
  `COALESCE((SELECT SUM(MAX(0, mul.quantity - ${LINE_CONSUMED_SQL}))
             FROM machine_program_upper_lines mul
             JOIN machine_program_runs mpr ON mpr.id = mul.run_id
             JOIN machine_programs mp ON mp.id = mpr.program_id
             WHERE mp.status = '${MACHINE_PROGRAM_STATUS.PROGRAMMED}'
               AND mul.item_id = ? AND mul.id <> ?${supplierClause}), 0)`;

export const RESERVED_FOR_ITEM_SQL = reservedSql("");
export const RESERVED_FOR_SUPPLIER_SQL = reservedSql(" AND mul.supplier_party_id = ?");
export const RESERVED_UNATTRIBUTED_SQL = reservedSql(" AND mul.supplier_party_id IS NULL");

/** One attribute value of the material aliased `alias`, read by its field key. */
export const attributeSql = (alias: string, fieldKey: string): string =>
  `(SELECT v.text_value FROM inventory_item_values v
     JOIN inventory_category_fields f ON f.id = v.field_id
    WHERE v.item_id = ${alias}.id AND f.field_key = '${fieldKey}' LIMIT 1)`;

export const COLOUR_SQL = attributeSql("ii", RAW_MATERIAL_ATTRIBUTE.COLOUR);
export const TYPE_SQL = attributeSql("ii", RAW_MATERIAL_ATTRIBUTE.TYPE);
export const ARTICLE_SQL = attributeSql("ii", RAW_MATERIAL_ATTRIBUTE.ARTICLE);
export const SIZE_SQL = attributeSql("ii", RAW_MATERIAL_ATTRIBUTE.SIZE);

/**
 * The joins that give a material (`ii`) its kind — the TOP-level category, DANA or UPPER —
 * whether it sits in that category or in one of its sub-categories.
 */
export const KIND_JOINS = `JOIN inventory_categories kind_cat ON kind_cat.id = ii.category_id
       LEFT JOIN inventory_categories kind_parent ON kind_parent.id = kind_cat.parent_id`;
export const KIND_SQL = "UPPER(COALESCE(kind_parent.name, kind_cat.name))";
