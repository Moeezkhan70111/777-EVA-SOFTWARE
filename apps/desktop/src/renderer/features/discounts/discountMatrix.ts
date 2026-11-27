// THE DISCOUNT POLICY AS A GRID (owner, 28 Nov 2026: the PDF "like this — Party name | Evr Gents | Evr Kids | Evr Ladies,
// one row per party"). The report's rules, one line each, turned into one row per party and one column per thing a
// discount is on (a product group, an article series, an article, a price range), with each cell the discount per
// pair. Product groups come first, then series, articles and ranges, each A to Z, so EVR GENTS, EVR KIDS, EVR LADIES
// read in that order. A party with no rule for a column has an empty cell. Pure: the PDF only draws it.

export interface DiscountReportRow {
  readonly partyId: string;
  readonly partyName: string;
  readonly type: string;
  readonly label: string;
  /** Rupees per pair, as the report gives it. */
  readonly discountPerPair: number;
}

export interface DiscountColumn {
  readonly key: string;
  readonly type: string;
  readonly label: string;
}

export interface DiscountMatrixRow {
  readonly partyId: string;
  readonly partyName: string;
  /** Discount per pair by column key; a column the party has no rule for is absent. */
  readonly cells: Readonly<Record<string, number>>;
}

export interface DiscountMatrix {
  readonly columns: readonly DiscountColumn[];
  readonly rows: readonly DiscountMatrixRow[];
}

const TYPE_ORDER = ["PRODUCT_GROUP", "ARTICLE_SERIES", "ARTICLE", "PRICE_RANGE"];
const rank = (type: string): number => {
  const at = TYPE_ORDER.indexOf(type);
  return at < 0 ? TYPE_ORDER.length : at;
};
const keyOf = (row: Pick<DiscountReportRow, "type" | "label">): string => `${row.type}\u0000${row.label}`;
const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

export function discountMatrix(report: readonly DiscountReportRow[]): DiscountMatrix {
  const columns = new Map<string, DiscountColumn>();
  const parties = new Map<string, { partyName: string; cells: Record<string, number> }>();
  for (const rule of report) {
    const key = keyOf(rule);
    if (!columns.has(key)) columns.set(key, { key, type: rule.type, label: rule.label });
    const party = parties.get(rule.partyId) ?? { partyName: rule.partyName, cells: {} };
    // One rule per party and column; should two ever arrive, the first stands.
    if (!(key in party.cells)) party.cells[key] = rule.discountPerPair;
    parties.set(rule.partyId, party);
  }
  return {
    columns: [...columns.values()].sort((a, b) => rank(a.type) - rank(b.type) || byName(a.label, b.label)),
    rows: [...parties.entries()].map(([partyId, party]) => ({ partyId, ...party })).sort((a, b) => byName(a.partyName, b.partyName)),
  };
}
