// A MATERIAL'S NAME, SPLIT IN TWO for the scan rail (0.3.9). Real names are long —
// "UPPER — RUBBER UPPER — SK52 — BLACK BLUE — 8/10" wraps to three lines — so the category goes on
// a small line above ("Upper · Rubber upper") and the part that tells materials apart is the
// headline ("SK52 · BLACK BLUE · 8/10"). Parts are joined with a middle dot: em dashes are wide.
//
// The category is found by the store's own category paths, not by position: a category with no
// sub-category has one part, one with a sub-category two, and only the paths say which.

export interface MaterialName {
  /** "Upper · Rubber upper"; null when no known category starts the name. */
  category: string | null;
  /** "SK52 · BLACK BLUE · 8/10". */
  name: string;
}

const PART = " — ";

/** "RUBBER UPPER" → "Rubber upper": one sentence-case word group, so the small line reads quietly. */
const sentenceCase = (part: string): string => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part);

/** Splits a display name by the longest category path ("UPPER — RUBBER UPPER") it starts with. */
export const splitMaterialName = (displayName: string, categoryPaths: readonly string[]): MaterialName => {
  const full = displayName.trim();
  const path = categoryPaths
    .filter((candidate) => candidate && full.startsWith(`${candidate}${PART}`))
    .reduce<string | null>((longest, candidate) => (!longest || candidate.length > longest.length ? candidate : longest), null);
  const rest = path ? full.slice(path.length + PART.length) : full;
  return {
    category: path ? path.split(PART).map(sentenceCase).join(" · ") : null,
    name: rest.split(PART).join(" · "),
  };
};
