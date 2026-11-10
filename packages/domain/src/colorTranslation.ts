// What the factory floor calls each colour, in Urdu: the one source of truth (master data COLOR_TRANSLATION).
//
// A colour is stored and synchronised in English, always: a product variant's colour, a carton's QR identity,
// a material's Colour attribute. Urdu is how it is SHOWN -- on the carton sticker, the raw material label,
// the Carton Stock matrix -- and this module is the only place that turns one into the other.
//
// The floor's word is often the English trade name written in Urdu script ("blue" -> "بلو"), not the literary
// Urdu word ("نیلا"): the list is the owner's, not a dictionary's. Its Urdu is kept exactly as entered --
// trimmed, nothing else -- because a "corrected" spelling is a different word to the person reading it.
//
// ENGLISH KEYS are case-insensitive and whitespace-safe: " Army  green " and "ARMY GREEN" are one key.

/** One mapping, as the application reads it. */
export interface ColorTranslation {
  readonly id: string;
  /** How the colour is written in English, as entered ("Army Green"). */
  readonly englishName: string;
  /** What the floor calls it, exactly as entered. */
  readonly urduName: string;
}

/**
 * The list every computer starts with (local migration 106 seeds exactly these, checked by a test). The first
 * fifteen are the owner's list of 2026-11-10. The rest were the built-in dictionary of the raw material label
 * (renderer utils/urdu.ts) before this list existed, kept so no label changes: none of them conflicts with the
 * owner's list, and the ten names both had are spelled identically.
 */
export const DEFAULT_COLOR_TRANSLATIONS: ReadonlyArray<{ readonly english: string; readonly urdu: string }> = [
  { english: "Black", urdu: "سیاہ" },
  { english: "Navy", urdu: "نیوی" },
  { english: "Blue", urdu: "بلو" },
  { english: "Yellow", urdu: "پیلا" },
  { english: "Neon", urdu: "نیون" },
  { english: "Red", urdu: "لال" },
  { english: "Grey", urdu: "گرے" },
  { english: "Orange", urdu: "اورنج" },
  { english: "Commando", urdu: "کمانڈو" },
  { english: "Army Green", urdu: "آرمی گرین" },
  { english: "Pink", urdu: "پنک" },
  { english: "Coffee", urdu: "کافی" },
  { english: "Light", urdu: "لایٹ" },
  { english: "Dark", urdu: "ڈارک" },
  { english: "White", urdu: "سفید" },
  // From the raw material label's own dictionary.
  { english: "Brown", urdu: "براؤن" },
  { english: "Cream", urdu: "کریم" },
  { english: "Skin", urdu: "سکن" },
  { english: "Army", urdu: "آرمی" },
  { english: "Green", urdu: "گرین" },
  { english: "Sky", urdu: "سکائ" },
  { english: "Gray", urdu: "گرے" },
  { english: "Mustard", urdu: "مسٹرڈ" },
];

/** The record id a seeded mapping has on every computer, so the same colour is the same record everywhere. */
export const seededColorTranslationId = (english: string): string => `color:${normalizeColorKey(english).replace(/ /g, "-")}`;

/** The English key a colour is matched by: lower case, trimmed, inner whitespace collapsed. */
export const normalizeColorKey = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();

/** Urdu as it is compared: trimmed, inner whitespace collapsed. Never otherwise changed. */
export const normalizeUrduText = (value: string): string => value.trim().replace(/\s+/g, " ");

const ARABIC_SCRIPT = /[؀-ۿ]/;

/** Whether a value is written (at least partly) in Urdu script. */
export const isUrduText = (value: string): boolean => ARABIC_SCRIPT.test(value);

/** English key -> Urdu, built once from the list and reused for every lookup. */
export type ColorDictionary = ReadonlyMap<string, string>;

export const buildColorDictionary = (rows: ReadonlyArray<Pick<ColorTranslation, "englishName" | "urduName">>): ColorDictionary => {
  const dictionary = new Map<string, string>();
  for (const row of rows) {
    const key = normalizeColorKey(row.englishName);
    if (key) dictionary.set(key, row.urduName.trim());
  }
  return dictionary;
};

/** The dictionary every computer starts with, before (or without) its stored list. */
export const DEFAULT_COLOR_DICTIONARY: ColorDictionary = buildColorDictionary(
  DEFAULT_COLOR_TRANSLATIONS.map((row) => ({ englishName: row.english, urduName: row.urdu }))
);

/**
 * A run-together colour named piece by piece: "blackred" -> "سیاہ لال". A carton's QR identity cannot hold a
 * space, so "BLACK RED" is stored as "BLACKRED" and its names have to be found inside the one token. Only a
 * token that splits ENTIRELY into known names is accepted, longest name first; anything else is unknown.
 */
const namedRun = (run: string, dictionary: ColorDictionary): string | undefined => {
  const names = [...dictionary.keys()].filter((name) => !name.includes(" ")).sort((left, right) => right.length - left.length);
  const split = (rest: string): string[] | undefined => {
    if (!rest) return [];
    for (const name of names) {
      if (!rest.startsWith(name)) continue;
      const tail = split(rest.slice(name.length));
      if (tail) return [dictionary.get(name) as string, ...tail];
    }
    return undefined;
  };
  const parts = split(run);
  return parts && parts.length > 1 ? parts.join(" ") : undefined;
};

/**
 * "BLACK" -> "سیاہ", or undefined when the list does not name it. A whole name wins ("army green"); otherwise a
 * compound is named word by word ("cream mustard" -> "کریم مسٹرڈ"), each word whole or run together
 * ("blackred"). A value already in Urdu is returned as it is.
 */
export const colorToUrdu = (value: string, dictionary: ColorDictionary): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (isUrduText(trimmed)) return trimmed;
  const key = normalizeColorKey(trimmed);
  const whole = dictionary.get(key);
  if (whole) return whole;
  const named = key.split(" ").map((word) => dictionary.get(word) ?? namedRun(word, dictionary));
  return named.every((word): word is string => Boolean(word)) ? named.join(" ") : undefined;
};

/** For a screen: the Urdu name, or the colour exactly as stored when the list does not name it. */
export const colorForDisplay = (value: string, dictionary: ColorDictionary): string => colorToUrdu(value, dictionary) ?? value;

/** What an Urdu colour stands for in English. AMBIGUOUS when two English names share it (Grey and Gray). */
export type UrduColorMatch =
  | { readonly status: "FOUND"; readonly english: string }
  | { readonly status: "AMBIGUOUS"; readonly candidates: readonly string[] }
  | { readonly status: "UNKNOWN" };

/** Every English name (as entered) whose Urdu is exactly this one. */
const englishFor = (urdu: string, rows: ReadonlyArray<Pick<ColorTranslation, "englishName" | "urduName">>): string[] =>
  rows.filter((row) => normalizeUrduText(row.urduName) === urdu).map((row) => row.englishName.trim());

/**
 * "سیاہ لال" -> "Black Red". A whole match wins; otherwise each word is matched on its own. `allowed`, when
 * given, narrows the candidates to the English values a field actually offers -- a dropdown that has GREY and
 * not GRAY makes "گرے" mean GREY.
 */
export const urduToEnglish = (
  value: string,
  rows: ReadonlyArray<Pick<ColorTranslation, "englishName" | "urduName">>,
  allowed?: readonly string[]
): UrduColorMatch => {
  const urdu = normalizeUrduText(value);
  if (!urdu) return { status: "UNKNOWN" };
  const allowedKeys = allowed ? new Set(allowed.map(normalizeColorKey)) : null;
  const narrow = (names: string[]): string[] => (allowedKeys ? names.filter((name) => allowedKeys.has(normalizeColorKey(name))) : names);
  const whole = narrow(englishFor(urdu, rows));
  if (whole.length === 1) return { status: "FOUND", english: whole[0] as string };
  if (whole.length > 1) return { status: "AMBIGUOUS", candidates: whole };
  const words = urdu.split(" ");
  if (words.length < 2) return { status: "UNKNOWN" };
  const parts = words.map((word) => englishFor(word, rows));
  if (parts.some((names) => names.length === 0)) return { status: "UNKNOWN" };
  if (parts.some((names) => names.length > 1)) return { status: "AMBIGUOUS", candidates: parts.map((names) => names.join("/")) };
  const english = parts.map((names) => names[0]).join(" ");
  return allowedKeys && !allowedKeys.has(normalizeColorKey(english)) ? { status: "UNKNOWN" } : { status: "FOUND", english };
};

// ─── Validating an entry (the page, and the data layer again) ───────────────────

export const COLOR_NAME_MAX_LENGTH = 60;

export const COLOR_TRANSLATION_ERROR = {
  ENGLISH_REQUIRED: "ENGLISH_REQUIRED",
  ENGLISH_NOT_LATIN: "ENGLISH_NOT_LATIN",
  ENGLISH_TOO_LONG: "ENGLISH_TOO_LONG",
  URDU_REQUIRED: "URDU_REQUIRED",
  URDU_NOT_URDU: "URDU_NOT_URDU",
  URDU_TOO_LONG: "URDU_TOO_LONG",
  DUPLICATE_ENGLISH: "DUPLICATE_ENGLISH",
  NOT_FOUND: "NOT_FOUND",
} as const;

export type ColorTranslationError = (typeof COLOR_TRANSLATION_ERROR)[keyof typeof COLOR_TRANSLATION_ERROR];

/** English colour names are letters, digits, spaces and the joiners a trade name uses ("S-PINK", "7/10"). */
const ENGLISH_NAME = /^[A-Za-z0-9][A-Za-z0-9 \-/&.]*$/;

/** The first thing wrong with an entry, or null. Duplicates are the data layer's to find: it holds the list. */
export const validateColorTranslation = (englishName: string, urduName: string): ColorTranslationError | null => {
  const english = englishName.trim();
  const urdu = urduName.trim();
  if (!english) return COLOR_TRANSLATION_ERROR.ENGLISH_REQUIRED;
  if (english.length > COLOR_NAME_MAX_LENGTH) return COLOR_TRANSLATION_ERROR.ENGLISH_TOO_LONG;
  if (!ENGLISH_NAME.test(english)) return COLOR_TRANSLATION_ERROR.ENGLISH_NOT_LATIN;
  if (!urdu) return COLOR_TRANSLATION_ERROR.URDU_REQUIRED;
  if (urdu.length > COLOR_NAME_MAX_LENGTH) return COLOR_TRANSLATION_ERROR.URDU_TOO_LONG;
  if (!isUrduText(urdu) || /[A-Za-z]/.test(urdu)) return COLOR_TRANSLATION_ERROR.URDU_NOT_URDU;
  return null;
};
