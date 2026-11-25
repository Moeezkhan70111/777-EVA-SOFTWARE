import { copy } from "../../config/copy";

// A PASTED LIST OF PARTIES (owner, 25 Nov 2026): what was pasted, read into names; and the main process's answer,
// checked (R25). Nothing here decides whether a party already exists: the data layer does (addPartiesFromList).
//
//   | English Name          | Urdu Name          |     a table from a chat or a document
//   | --------------------- | ------------------ |
//   | ABDUL GHANI HYDERABAD | عبدل غنی حیدرآباد  |
//   ABDUL GHANI HYDERABAD<TAB>عبدل غنی حیدرآباد      two cells copied from Excel
//   ABDUL GHANI HYDERABAD                            a name alone

export interface PastedParty {
  partyName: string;
  partyNameUrdu: string;
}

const URDU_LETTER = /[؀-ۿ]/;
const HEADER_NAMES = new Set(["english name", "party name", "name", "english"]);
const isSeparator = (cells: readonly string[]) => cells.every((cell) => /^:?-{2,}:?$/.test(cell));

const cellsOf = (line: string): string[] => {
  if (line.includes("|")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells[0] === "") cells.shift();
    if (cells[cells.length - 1] === "") cells.pop();
    return cells;
  }
  return line.split("\t").map((cell) => cell.trim());
};

/** One line's party, or null for a blank, a header or a table's ruling line. Urdu written first is put second. */
const partyOf = (line: string): PastedParty | null => {
  const cells = cellsOf(line).filter((cell) => cell !== "");
  const [first = "", second = ""] = cells;
  if (!first || isSeparator(cells) || HEADER_NAMES.has(first.toLowerCase())) return null;
  if (URDU_LETTER.test(first) && second && !URDU_LETTER.test(second)) return { partyName: second, partyNameUrdu: first };
  return { partyName: first, partyNameUrdu: second };
};

/** The parties in what was pasted, in its order. */
export const partiesFromText = (text: string): PastedParty[] =>
  text.split(/\r?\n/).map(partyOf).filter((party): party is PastedParty => party !== null);

export type PartiesFromListReply =
  | { ok: true; created: Array<{ partyName: string; partyCode: string }>; skipped: string[] }
  | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isCreated = (value: unknown): value is { partyName: string; partyCode: string } =>
  isRecord(value) && typeof value.partyName === "string" && typeof value.partyCode === "string";

export const parsePartiesFromListReply = (reply: unknown): PartiesFromListReply => {
  const words = copy.partiesFromList;
  if (!isRecord(reply)) return { ok: false, reason: words.failed };
  if (reply.accepted !== true) return { ok: false, reason: typeof reply.reason === "string" ? reply.reason : words.failed };
  const { created, skipped } = reply;
  if (!Array.isArray(created) || !created.every(isCreated)) return { ok: false, reason: words.failed };
  if (!Array.isArray(skipped) || !skipped.every((name) => typeof name === "string")) return { ok: false, reason: words.failed };
  return { ok: true, created, skipped };
};
