import { materialNameParts, type InventoryItemRow } from "./rawMaterial";

// The Stock tab's list grouped by category and sub-category (1 Nov 2026). Presentation only: the
// materials and their balances are the data layer's; this orders them so each group sits together,
// cuts a page into its groups, and counts what each category holds.

/** A material's place: its top-level category and, when it has one, its sub-category. */
const topOf = (item: InventoryItemRow): string => String(item.top_category_name ?? item.category_name ?? "");
const subOf = (item: InventoryItemRow): string => String(item.sub_category_name ?? "");

/** Numbers by value, so DC5 comes before DC47 and 1.5 INCH after 1 INCH. */
const naturally = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** Category, then sub-category (the category's own materials first), then name. */
export const sortForStock = (items: readonly InventoryItemRow[]): InventoryItemRow[] =>
  [...items].sort(
    (a, b) =>
      naturally(topOf(a), topOf(b)) ||
      naturally(subOf(a), subOf(b)) ||
      naturally(String(a.display_name ?? ""), String(b.display_name ?? ""))
  );

export interface StockSubGroup {
  key: string;
  /** The sub-category's name, or "" for materials filed on the category itself. */
  subCategory: string;
  items: InventoryItemRow[];
}

export interface StockGroup {
  key: string;
  category: string;
  subGroups: StockSubGroup[];
}

/** One page of sorted materials, cut into its categories and their sub-categories, in order. */
export const groupStockPage = (rows: readonly InventoryItemRow[]): StockGroup[] => {
  const groups: StockGroup[] = [];
  for (const item of rows) {
    const category = topOf(item);
    const subCategory = subOf(item);
    let group = groups[groups.length - 1];
    if (!group || group.category !== category) {
      group = { key: category || "-", category, subGroups: [] };
      groups.push(group);
    }
    let sub = group.subGroups[group.subGroups.length - 1];
    if (!sub || sub.subCategory !== subCategory) {
      sub = { key: `${category}|${subCategory}`, subCategory, items: [] };
      group.subGroups.push(sub);
    }
    sub.items.push(item);
  }
  return groups;
};

export interface CategoryCount {
  materials: number;
  /** Materials with something in store. */
  inStock: number;
}

/** What each category holds across the whole list, not only the page on screen. */
export const categoryCounts = (items: readonly InventoryItemRow[]): Map<string, CategoryCount> => {
  const counts = new Map<string, CategoryCount>();
  for (const item of items) {
    const count = counts.get(topOf(item)) ?? { materials: 0, inStock: 0 };
    count.materials += 1;
    if (Number(item.quantity_on_hand ?? 0) > 0) count.inStock += 1;
    counts.set(topOf(item), count);
  }
  return counts;
};

/**
 * A material's name in two parts for its row: what leads ("1 INCH") and the rest ("DOUBLE PIROYI"),
 * with the category part left off — the group heading already says it.
 */
export const stockNameParts = (item: InventoryItemRow): { lead: string; rest: string } => {
  const top = topOf(item);
  const sub = subOf(item);
  const category = sub ? `${top} — ${sub}` : top;
  const [lead, ...rest] = materialNameParts(String(item.display_name ?? ""), category);
  return { lead: lead ?? String(item.display_name ?? ""), rest: rest.join(" — ") };
};
