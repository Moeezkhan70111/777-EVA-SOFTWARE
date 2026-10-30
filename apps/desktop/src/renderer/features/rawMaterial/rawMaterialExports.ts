import type {
  InventoryStockEventRow,
  PurchaseVoucher,
  RawMaterialMovementConfigRow,
  RawMaterialQrBatchRow,
} from "../../types/desktopApi";
import type { CsvSheet } from "../../utils/exportFile";
import type { ReportDocument } from "../../utils/reportDocument";
import { formatDate, formatDateTime } from "../../utils/dates";
import { formatWholeMoney } from "../../app/format";
import {
  STOCK_EVENT_LABELS,
  formatQuantity,
  packCountLabel,
  packetsInStore,
  type CategoryRow,
  type InventoryItemRow,
} from "./rawMaterial";

// What each Raw Material export contains.
//
// Every builder reads the rows the screen is already showing — the same authoritative data,
// already filtered, already totalled by the data layer. Nothing here recalculates stock: an
// export that disagreed with the screen it was taken from would be worse than no export.
//
// Column names are stable and shared: the materials export and the import template use the
// same vocabulary (Category, the attribute labels, Unit, Cost price), so a file exported today
// can be edited and imported back. What a packet holds is not a material column: it is typed
// for each label run and printed on the label.

/** The attribute columns for the materials sheet: every attribute used by any category shown. */
const attributeHeaders = (categories: CategoryRow[]): string[] => {
  const seen = new Map<string, string>();
  for (const category of categories) {
    for (const field of category.fields ?? []) {
      if (String(field.field_type) === "UNIT") continue;
      const key = String(field.field_key ?? "");
      if (key && !seen.has(key)) seen.set(key, String(field.label ?? key));
    }
  }
  return [...seen.values()];
};

const attributeValue = (item: InventoryItemRow, label: string): string => {
  const values = Array.isArray(item.values) ? (item.values as Array<Record<string, unknown>>) : [];
  const match = values.find((value) => String(value.label ?? "") === label);
  if (!match) return "";
  return String(match.text_value ?? match.number_value ?? "");
};

/**
 * Materials and their stock — the analysis sheet, and the round-trip for the import.
 *
 * Master columns come first (what a material IS), then the live figures (what it currently
 * holds), so the left-hand block matches the import template column for column.
 */
export const buildMaterialsSheet = (
  items: InventoryItemRow[],
  configByItem: Map<string, RawMaterialMovementConfigRow>,
  categories: CategoryRow[],
  filterSummary: string[]
): CsvSheet => {
  const attributes = attributeHeaders(categories);
  return {
    preamble: ["777 ERP — Raw Materials & Stock", `Taken ${formatDateTime(new Date().toISOString())}`, ...filterSummary],
    headers: [
      "Category",
      "Sub-category",
      ...attributes,
      "Unit",
      "Cost price",
      "Item code",
      "Packets in store",
      "In store",
    ],
    rows: items.map((item) => {
      const config = configByItem.get(String(item.id));
      return [
        String(item.top_category_name ?? item.category_name ?? ""),
        String(item.sub_category_name ?? ""),
        ...attributes.map((label) => attributeValue(item, label)),
        String(item.unit_code ?? ""),
        item.cost_price == null ? "" : Number(item.cost_price),
        String(item.item_code ?? ""),
        // Blank, not 0, where no packet is counted: off the store computer that is no count at all.
        packetsInStore(config) ?? "",
        formatQuantity(Number(item.quantity_on_hand ?? 0)),
      ];
    }),
  };
};

/**
 * The printable stock report: what is on the shelf, under which filters, at which moment.
 *
 * Deliberately narrower than the spreadsheet — no cost price, no item codes, no setup flags.
 * A page somebody carries round the store wants the material, the count and the totals.
 */
export const buildStockReport = (
  items: InventoryItemRow[],
  configByItem: Map<string, RawMaterialMovementConfigRow>,
  filters: Array<{ label: string; value: string }>,
  totalsByUnit: Array<{ unitCode: string; quantity: number }>
): ReportDocument => ({
  title: "Raw Material Stock Report",
  filters,
  columns: [
    { label: "Material" },
    { label: "Code" },
    { label: "In store", numeric: true },
    { label: "Total qty", numeric: true },
  ],
  rows: items.map((item) => {
    const config = configByItem.get(String(item.id));
    const onHand = Number(item.quantity_on_hand ?? 0);
    const packs = packetsInStore(config);
    return [
      String(item.display_name ?? ""),
      String(item.item_code ?? ""),
      // Packs are what somebody walking the store counts; the measured total sits beside it.
      packs == null ? `${formatQuantity(onHand)} ${String(item.unit_code ?? "")}`.trim() : packCountLabel(packs, config),
      `${formatQuantity(onHand)} ${String(item.unit_code ?? "")}`.trim(),
    ];
  }),
  totals: [
    { label: "Materials", value: String(items.length) },
    ...totalsByUnit.map((total) => ({ label: total.unitCode, value: formatQuantity(total.quantity) })),
  ],
  footnote:
    "Counts are the store's current balance. Stock moves on Raw Material Input and Output scans; " +
    "manual corrections are approved by an administrator and appear in each material's movement history.",
  emptyMessage: "No raw materials matched these filters.",
});

/** One material's stock movements — the ledger behind its balance. */
export const buildMovementSheet = (item: InventoryItemRow, events: InventoryStockEventRow[]): CsvSheet => ({
  preamble: [
    `777 ERP — Movement history: ${String(item.display_name ?? "")}`,
    `${String(item.item_code ?? "")} · in store ${formatQuantity(Number(item.quantity_on_hand ?? 0))} ${String(item.unit_code ?? "")}`,
    `Taken ${formatDateTime(new Date().toISOString())}`,
  ],
  headers: ["When", "What", "Change", "Unit", "Note", "By"],
  rows: events.map((event) => [
    formatDateTime(event.createdAt),
    STOCK_EVENT_LABELS[event.eventType] ?? event.eventType,
    `${event.quantity > 0 ? "+" : ""}${formatQuantity(event.quantity)}`,
    event.unitCode ?? "",
    event.note ?? "",
    event.createdBy ?? "",
  ]),
});

/**
 * Purchase bills, one row per LINE.
 *
 * A bill is the unit people file, but a line is the unit people analyse — "how much SK6 did
 * we buy from Al Noor in September" needs the material on every row. The bill's own fields
 * repeat down its lines so the sheet can be pivoted without unmerging anything.
 */
export const buildPurchaseLinesSheet = (vouchers: PurchaseVoucher[], filterSummary: string[]): CsvSheet => ({
  preamble: ["777 ERP — Raw Material Purchases", `Taken ${formatDateTime(new Date().toISOString())}`, ...filterSummary],
  headers: [
    "Bill no.",
    "Date",
    "Supplier",
    "Reference",
    "Material",
    "Item code",
    "Quantity",
    "Unit",
    "Unit price",
    "Line total",
    "Remarks",
  ],
  rows: vouchers.flatMap((voucher) =>
    voucher.lineItems.map((line) => [
      voucher.voucherNumber,
      formatDate(voucher.voucherDate),
      voucher.partyName,
      voucher.referenceNo ?? "",
      line.displayName,
      line.itemCode,
      formatQuantity(line.quantity),
      line.unitCode ?? "",
      formatWholeMoney(line.unitPrice),
      formatWholeMoney(line.totalPrice),
      voucher.remarks ?? "",
    ])
  ),
});

/**
 * Label batches — which codes were registered, for whom, by whom.
 *
 * The identity range plus the quantity describes every code in the batch, because serials are
 * consecutive: `…_000001` → `…_000100` IS the list. So there is no separate "export the
 * identities" action to keep in step with this one.
 */
export const buildQrBatchSheet = (
  batches: RawMaterialQrBatchRow[],
  identityAt: (partyCode: string, itemCode: string, sequence: number) => string
): CsvSheet => ({
  preamble: ["777 ERP — Raw Material Label Batches", `Taken ${formatDateTime(new Date().toISOString())}`],
  headers: [
    "Generated",
    "Supplier",
    "Raw material",
    "Item code",
    "First label",
    "Last label",
    "Labels",
    "Generated by",
    "Requested by",
  ],
  rows: batches.map((batch) => [
    formatDateTime(batch.createdAt),
    batch.partyName,
    batch.itemDisplayName,
    batch.itemCode,
    identityAt(batch.partyCode, batch.itemCode, batch.startSequence),
    identityAt(batch.partyCode, batch.itemCode, batch.endSequence),
    batch.quantity,
    batch.createdBy ?? "",
    batch.requestedBy ?? "",
  ]),
});

/**
 * The attribute model: one row per attribute, with its category.
 *
 * Reference and backup for whoever owns the setup — not an import. An attribute's key feeds
 * the signature that gives every material its identity, so it is changed deliberately in the
 * Setup tab, never by uploading a file.
 */
export const buildSetupSheet = (categories: CategoryRow[]): CsvSheet => ({
  preamble: ["777 ERP — Raw Material Categories & Attributes", `Taken ${formatDateTime(new Date().toISOString())}`],
  headers: ["Category", "Description", "Attribute", "Key", "Type", "Required", "Searchable", "Saved options"],
  rows: categories.flatMap((category) => {
    const fields = category.fields ?? [];
    if (fields.length === 0) {
      return [[String(category.name ?? ""), String(category.description ?? ""), "(no attributes)", "", "", "", "", ""]];
    }
    return fields.map((field) => {
      const options = Array.isArray(field.options) ? (field.options as Array<Record<string, unknown>>) : [];
      return [
        String(category.name ?? ""),
        String(category.description ?? ""),
        String(field.label ?? ""),
        String(field.field_key ?? ""),
        String(field.field_type ?? ""),
        field.is_required ? "Yes" : "No",
        field.is_searchable ? "Yes" : "No",
        options.map((option) => String(option.option_value ?? "")).join(", "),
      ];
    });
  }),
});
