import { normalizeColorKey } from "@erp/domain";

// COLOUR CORRECTIONS THIS COMPUTER LEARNED BEFORE THE SHARED LIST EXISTED.
//
// Until docs/45, correcting a material's Urdu colour by hand also remembered the correction in this computer's
// browser storage (key below), so the next material in that colour got it -- on this computer only. Nothing writes
// there any more: the shared colour list replaces it.
//
// It is READ, not discarded, so no correction is lost: a colour the shared list does not name keeps its learned
// Urdu here until someone adds it to the list, and the Color Translation page shows every learned correction
// beside what the list says, for a person to add or resolve. The list wins wherever it names the colour.

export const LEGACY_COLOR_CORRECTIONS_KEY = "erp_learned_color_urdu_words";

/** English key -> Urdu, as this computer learned them. Empty when there are none or storage is unavailable. */
export const readLegacyColorCorrections = (): ReadonlyMap<string, string> => {
  const corrections = new Map<string, string>();
  try {
    const saved = window.localStorage.getItem(LEGACY_COLOR_CORRECTIONS_KEY);
    const parsed: unknown = saved ? JSON.parse(saved) : null;
    if (typeof parsed !== "object" || parsed === null) return corrections;
    for (const [english, urdu] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeColorKey(english);
      if (key && typeof urdu === "string" && urdu.trim()) corrections.set(key, urdu.trim());
    }
  } catch {
    // Storage may be unavailable or hold something unreadable: there is then nothing learned to show.
  }
  return corrections;
};

/** One learned correction, against what the shared list says for the same colour. */
export interface LegacyCorrection {
  readonly englishKey: string;
  readonly urdu: string;
  /** NEW: the list does not name it. CONFLICT: the list names it differently. */
  readonly status: "NEW" | "CONFLICT";
  /** The list's Urdu, for a CONFLICT. */
  readonly listUrdu?: string;
}

/** The learned corrections that still need a person: those the list lacks, and those it disagrees with. */
export const pendingLegacyCorrections = (dictionary: ReadonlyMap<string, string>, learned = readLegacyColorCorrections()): LegacyCorrection[] => {
  const pending: LegacyCorrection[] = [];
  for (const [englishKey, urdu] of learned) {
    const listUrdu = dictionary.get(englishKey);
    if (listUrdu === undefined) pending.push({ englishKey, urdu, status: "NEW" });
    else if (listUrdu !== urdu) pending.push({ englishKey, urdu, status: "CONFLICT", listUrdu });
  }
  return pending.sort((left, right) => left.englishKey.localeCompare(right.englishKey));
};
