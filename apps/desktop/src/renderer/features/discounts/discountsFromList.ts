// A PASTED LIST OF DISCOUNTS (owner, 26 Nov 2026): "party | discount per pair", one party a line, for the product group,
// article series or article chosen on the Discount Policy page. Read the way Paste parties reads (partiesFromList.ts):
//
//   | Party                 | Discount |      a table from a chat or a document (its header and ruling line skipped)
//   ABDUL GHANI HYDERABAD<TAB>12            two cells copied from Excel
//   عبدل غنی حیدرآباد | 12                   the Urdu name works too
//
// Each name is matched to a customer by its English name (any capitals, any spacing) or its Urdu name. Nothing here is
// saved: the matches fill the page's own table, which is checked and saved by the page's own Save, as if typed.

export interface ListedParty {
  id: string;
  partyName: string;
  partyNameUrdu?: string;
}

export interface MatchedDiscount {
  partyId: string;
  partyName: string;
  /** Rupees per pair, as typed: whole or with paisa, never below zero. */
  discountPerPair: number;
}

export interface DiscountListReading {
  matched: MatchedDiscount[];
  /** Names on the list that are not a customer: shown, never saved. */
  unmatched: string[];
  /** Lines whose discount is not a number of rupees: shown, never saved. */
  invalid: string[];
  /** A customer named twice: the last discount on the list is the one used. */
  repeated: string[];
}

const HEADER_WORDS = new Set(["party", "party name", "customer", "name", "discount", "discount per pair", "discount / pair"]);
const isSeparator = (cells: readonly string[]) => cells.every((cell) => /^:?-{2,}:?$/.test(cell));

const cellsOf = (line: string): string[] => {
  const raw = line.includes("|") ? line.split("|") : line.split("\t");
  return raw.map((cell) => cell.trim()).filter((cell) => cell !== "");
};

/** One name as it is compared: lower case, spaces collapsed. */
const nameKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

/** "12", "12.50", "Rs 12", "1,000": rupees per pair; null for anything that is not one (Postel: loose in, exact out). */
export const discountOf = (text: string): number | null => {
  const cleaned = text.replace(/rs\.?/i, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

/** The customers' names, English and Urdu, to their records. */
const indexOf = (parties: readonly ListedParty[]): Map<string, ListedParty> => {
  const index = new Map<string, ListedParty>();
  for (const party of parties) {
    index.set(nameKey(party.partyName), party);
    if (party.partyNameUrdu) index.set(nameKey(party.partyNameUrdu), party);
  }
  return index;
};

/** What was pasted, read against the customers. */
export const readDiscountList = (text: string, parties: readonly ListedParty[]): DiscountListReading => {
  const index = indexOf(parties);
  const byParty = new Map<string, MatchedDiscount>();
  const reading: DiscountListReading = { matched: [], unmatched: [], invalid: [], repeated: [] };
  for (const line of text.split(/\r?\n/)) {
    const cells = cellsOf(line);
    if (cells.length === 0 || isSeparator(cells)) continue;
    const [name = "", amount = ""] = cells.length >= 2 ? [cells.slice(0, -1).join(" "), cells[cells.length - 1] ?? ""] : [cells[0] ?? "", ""];
    if (HEADER_WORDS.has(nameKey(name)) && discountOf(amount) === null) continue;
    const discount = discountOf(amount);
    if (discount === null) { reading.invalid.push(line.trim()); continue; }
    const party = index.get(nameKey(name));
    if (!party) { reading.unmatched.push(name); continue; }
    if (byParty.has(party.id)) reading.repeated.push(party.partyName);
    byParty.set(party.id, { partyId: party.id, partyName: party.partyName, discountPerPair: discount });
  }
  reading.matched = [...byParty.values()];
  return reading;
};
