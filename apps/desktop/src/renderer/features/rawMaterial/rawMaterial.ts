import type { RawMaterialMovementConfigRow, RawMaterialSetupTemplate } from "../../types/desktopApi";
import { colorValueInUrdu } from "../../utils/urdu";

// Shared vocabulary for the Raw Material workspace: the row shapes the tabs pass around, and
// the handful of derivations that must mean the same thing on every tab.
//
// Nothing here calculates stock. The balance comes from the data layer
// (`inventory_stock_balances`, read through listInventoryItems / queryInventoryStock) and is
// only formatted for display — see CLAUDE.md §8.

/** A row of `listInventoryItems`. The data layer returns loose SQL rows, so reads are narrowed here. */
export type InventoryItemRow = Record<string, unknown>;

/** A category from `listInventoryCategories`, with its attribute fields attached. */
export type CategoryRow = Record<string, unknown> & { fields?: Array<Record<string, unknown>> };

export type WorkspaceTab = "stock" | "labels" | "receipts" | "setup";

/** Quantities are stored as REAL; three decimals is the most any unit in use needs. */
export const formatQuantity = (value: number): string => Number(value.toFixed(3)).toString();

export const asText = (value: unknown): string => (value == null ? "" : String(value));

export const itemId = (item: InventoryItemRow): string => String(item.id);

/** Attribute fields a human fills in. UNIT fields are the item's unit, not part of its identity. */
export const identityFields = (category: CategoryRow | undefined): Array<Record<string, unknown>> =>
  (category?.fields ?? []).filter((field) => String(field.field_type) !== "UNIT");

// ─── Categories and their sub-categories ──────────────────────────────────────
// A category may sit under another one, as deep as the business needs: a kind of a kind of a
// kind. A sub-category inherits the attributes of every ancestor, so `fields` on it already
// holds them all — the inherited ones carry `inherited_from`.

export const isSubCategory = (category: CategoryRow): boolean => Boolean(category.parent_id);

export const parentIdOf = (category: CategoryRow): string => String(category.parent_id ?? "");

/** "DANA — EVA" for a sub-category, "DANA" for a top-level one. */
export const categoryPath = (category: CategoryRow | undefined): string =>
  category ? String(category.path_name ?? category.name ?? "") : "";

/** The top-level categories, in name order. */
export const topCategories = (categories: CategoryRow[]): CategoryRow[] =>
  categories.filter((category) => !isSubCategory(category));

/** The sub-categories of one category, in name order. Direct children only. */
export const subCategoriesOf = (categories: CategoryRow[], parentId: string): CategoryRow[] =>
  parentId ? categories.filter((category) => parentIdOf(category) === parentId) : [];

/**
 * Everything beneath a category, however deep. Used to keep a category from being filed
 * inside its own branch, which would cut that branch out of the tree.
 */
export const descendantsOf = (categories: CategoryRow[], categoryId: string): CategoryRow[] => {
  const found: CategoryRow[] = [];
  const queue = [categoryId];
  const seen = new Set<string>([categoryId]);
  while (queue.length > 0) {
    for (const child of subCategoriesOf(categories, queue.shift()!)) {
      const id = String(child.id);
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(child);
      queue.push(id);
    }
  }
  return found;
};

/** How deep a category sits, so a tree can indent it. 0 is top level. */
export const categoryDepth = (categories: CategoryRow[], category: CategoryRow): number => {
  let depth = 0;
  let parentId = parentIdOf(category);
  const seen = new Set<string>([String(category.id)]);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = parentIdOf(categories.find((row) => String(row.id) === parentId) ?? {});
  }
  return depth;
};

/**
 * The category a material actually belongs to, given what the operator picked.
 *
 * A material may be filed at any level: directly on a category, or on any kind of it however
 * deep. So a chosen sub-category wins, and choosing none means "file it here". This is the one
 * place that is spelled out for the screens.
 */
export const materialCategoryId = (categoryId: string, subCategoryId: string): string =>
  !categoryId ? "" : subCategoryId || categoryId;

/**
 * What one printed label goes on, in the store's own word for it.
 *
 * Every material comes in its own container: DANA in a BAG, rubber topping in a PACKET,
 * ragzine on a ROLL. Without the name, "25 KILOGRAM" sits on a row next to a balance in
 * DOZEN and reads as "one dozen is twenty-five kilogram", which is not what anybody meant.
 * Materials with no name of their own are PACKETs — the store's everyday word.
 */
export const PACK_NAME_FALLBACK = "PACKET";

/** Containers the store already uses, offered so the same thing is not typed three ways. */
export const COMMON_PACK_NAMES = ["PACKET", "BAG", "BOTTLE", "ROLL", "BUNDLE", "BOX", "CARTON", "TIN", "CAN", "DRUM", "SHEET"];

/**
 * What the materials in a category come in: its own word, else its parent's. Null when neither
 * names one — the materials then fall back to PACKET. Mirrors EFFECTIVE_PACK_NAME_SQL.
 */
export const categoryPackName = (category: CategoryRow | undefined, categories: CategoryRow[]): string | null => {
  if (!category) return null;
  const own = String(category.pack_name ?? "").trim();
  if (own) return own;
  const parent = categories.find((row) => String(row.id) === String(category.parent_id ?? ""));
  const inherited = String(parent?.pack_name ?? "").trim();
  return inherited || null;
};

export const packName = (config: RawMaterialMovementConfigRow | undefined): string =>
  (config?.packName ?? "").trim() || PACK_NAME_FALLBACK;

/**
 * Whether a material can be issued out of the store: it needs somewhere to go. Receiving needs
 * nothing from the material — each label carries what its own packet holds.
 *
 * The UI only reports this — it never decides it.
 */
/**
 * A count of packs, pluralised the way English does it. Display only — the pack's name is
 * stored singular, and this is the seam Urdu replaces wholesale later.
 */
export const packCountLabel = (packs: number, config: RawMaterialMovementConfigRow | undefined): string => {
  const name = packName(config);
  if (Math.abs(packs - 1) < 1e-9) return `${formatQuantity(packs)} ${name}`;
  const plural = /(S|X|Z|CH|SH)$/.test(name) ? `${name}ES` : `${name}S`;
  return `${formatQuantity(packs)} ${plural}`;
};

/**
 * How many labelled packets the store is holding. Counted by the data layer, never divided out
 * of the balance: one packet may hold 5 DOZEN and the next 3, so 8 DOZEN is 2 PACKETS.
 *
 * Null when there are none, so a screen shows the measured balance instead of "0 PACKETS"
 * beside stock that arrived without a label (opening stock, an approved correction).
 */
export const packetsInStore = (config: RawMaterialMovementConfigRow | undefined): number | null =>
  config && config.packetsInStore > 0 ? config.packetsInStore : null;

/** "5 DOZEN" — what one packet holds, as written on its label. */
export const packetContentsLabel = (quantity: number, unitCode: string | null | undefined): string =>
  `${formatQuantity(quantity)} ${unitCode ?? ""}`.trim();

/** Why a material cannot be issued yet, in one sentence, or null when it can. */
export const notReadyReason = (config: RawMaterialMovementConfigRow | undefined): string | null => {
  if (!config || config.hops.length === 0) return "Give this material a route out of the store before it can be issued.";
  return null;
};

/**
 * A material's category as the path it lives at — "DANA — EVA", or just "RAGZINE" when the
 * category has no sub-categories. `category_name` alone is the leaf, which reads as "EVA".
 */
export const itemCategoryLabel = (item: InventoryItemRow): string => {
  const top = String(item.top_category_name ?? item.category_name ?? "");
  const sub = String(item.sub_category_name ?? "");
  return sub ? `${top} — ${sub}` : top;
};

/**
 * A material as a picker option. Its name is "CATEGORY — SUB — A — B — C"; the category part
 * is the same for every material in a sub-category, so the big line is what tells them apart
 * (SK19 · BROWN · 8/13) and the category and code go on the small line under it.
 */
export const materialPickerOption = (item: InventoryItemRow): { value: string; label: string; detail: string; keywords: string } => {
  const name = String(item.display_name ?? "");
  const category = itemCategoryLabel(item);
  const code = String(item.item_code ?? "");
  const prefix = category ? `${category} — ` : "";
  const distinguishing = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return {
    value: String(item.id),
    label: distinguishing.split(" — ").join(" · ") || name,
    detail: [category, code].filter(Boolean).join(" · "),
    keywords: name,
  };
};

/** One configured attribute and its value, for the raw material QR label. */
export interface MaterialLabelAttribute {
  label: string;
  value: string;
  /** Whether this is the Colour attribute — printed larger and in Urdu, not just as typed. */
  isColor: boolean;
}

/** Field labels an operator might give the Colour attribute when setting up a category. */
const COLOR_ATTRIBUTE_LABELS = new Set(["COLOR", "COLOUR"]);

/** Whether a category field is the Colour attribute, however the category labelled it. The one place this decision is made — the material form and the label print both call this. */
export const isColorFieldLabel = (label: string): boolean => COLOR_ATTRIBUTE_LABELS.has(label.trim().toUpperCase());

/**
 * A material's own (non-unit) attribute values, in category order, for the QR label's
 * attribute list. The unit is how the material is counted, not an identifying attribute of
 * it, so it is left off — the same filter `identityFields`/`buildInventoryDisplayName` apply.
 * The Colour attribute (however the category labelled it) prints in Urdu — the factory floor
 * reads Urdu, not English colour names — every other attribute prints as typed. A manual Urdu
 * correction entered on the material (`text_value_urdu`) wins over the automatic translation;
 * see NewMaterialModal, which is the only place that correction is entered.
 */
export const materialLabelAttributes = (item: InventoryItemRow): MaterialLabelAttribute[] => {
  const values = Array.isArray(item.values) ? (item.values as Array<Record<string, unknown>>) : [];
  return values
    .filter((value) => String(value.field_type) !== "UNIT")
    .map((value) => {
      const label = String(value.label ?? "");
      const rawValue = value.text_value != null ? String(value.text_value) : value.number_value != null ? String(value.number_value) : "";
      const isColor = isColorFieldLabel(label);
      const urduOverride = value.text_value_urdu != null ? String(value.text_value_urdu).trim() : "";
      const displayValue = isColor ? urduOverride || colorValueInUrdu(rawValue) : rawValue;
      return { label, value: displayValue, isColor };
    })
    .filter((attribute) => attribute.label && attribute.value);
};

/** "Packing → Upper Maker", or null when this material has no route out of the store. */
export const routeLabel = (config: RawMaterialMovementConfigRow | undefined): string | null =>
  !config || config.hops.length === 0 ? null : config.hops.map((hop) => hop.sectionName).join(" → ");

/**
 * What a new material in a sub-category will inherit, in one line.
 *
 * Said out loud before the material is created, because inheriting silently would mean an
 * operator only finds out what a pack is when the first label prints.
 */
export const setupTemplateLabel = (template: RawMaterialSetupTemplate): string => {
  const parts: string[] = [];
  if (template.unitCode) parts.push(`Counted in ${template.unitCode}`);
  if (template.hops.length > 0) parts.push(template.hops.map((hop) => hop.sectionName).join(" → "));
  return parts.join(" · ");
};

/** What the movement ledger's event types are called on screen. */
export const STOCK_EVENT_LABELS: Record<string, string> = {
  RECEIVE: "Received",
  ADJUST: "Adjusted",
  CONSUME: "Consumed",
  TRANSFER_IN: "Transferred in",
  TRANSFER_OUT: "Issued",
  RETURN: "Returned",
};

// ─── Category attributes ──────────────────────────────────────────────────────
// The attribute types a category can be given. UNIT is listed because the data layer
// accepts it, but it is explicitly not part of a material's identity — see identityFields.

export const FIELD_TYPES = ["TEXT", "NUMBER", "DROPDOWN", "UNIT"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  TEXT: "Text",
  NUMBER: "Number",
  DROPDOWN: "Dropdown",
  UNIT: "Unit",
};

export const FIELD_TYPE_HINTS: Record<FieldType, string> = {
  TEXT: "Free text — e.g. an article code or a batch number",
  NUMBER: "A numeric value",
  DROPDOWN: "Pick from a saved list — e.g. colours, sizes",
  UNIT: "Unit of measure — not used to tell materials apart",
};

/** One attribute in the shared library, with the categories already using it. */
export interface LibraryAttribute {
  fieldKey: string;
  label: string;
  fieldType: string;
  usedIn: string[];
}

/**
 * The attribute library, derived from the categories themselves.
 *
 * There is no global attribute table — an attribute exists by being attached to at least one
 * category — so the library is the de-duplicated union of every category's fields. Unchanged
 * from the Item Categories screen this replaced.
 */
export const buildAttributeLibrary = (categories: CategoryRow[]): LibraryAttribute[] => {
  const byKey = new Map<string, LibraryAttribute>();
  for (const category of categories) {
    const categoryName = String(category.name ?? "");
    for (const field of category.fields ?? []) {
      const key = String(field.field_key ?? "");
      if (!key) continue;
      const existing = byKey.get(key);
      if (existing) existing.usedIn.push(categoryName);
      else
        byKey.set(key, {
          fieldKey: key,
          label: String(field.label ?? key),
          fieldType: String(field.field_type ?? "TEXT"),
          usedIn: [categoryName],
        });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label));
};
