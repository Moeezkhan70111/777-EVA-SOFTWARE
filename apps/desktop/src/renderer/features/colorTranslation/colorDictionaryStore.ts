import { useSyncExternalStore } from "react";
import { DEFAULT_COLOR_TRANSLATIONS, buildColorDictionary, type ColorDictionary, type ColorTranslation } from "@erp/domain";
import { readLegacyColorCorrections } from "./legacyColorCorrections";

// THE COLOUR LIST AS EVERY SCREEN ON THIS COMPUTER SEES IT, kept in one place.
//
// The list itself is master data, read from the main process (useColorTranslations). It is held here as well
// because colours are turned into Urdu in places that are not React -- the carton sticker and the raw material
// label are built by plain functions at print time (utils/qrLabels.tsx, rawMaterial.ts) -- and they must read
// the same list the screens show. One store, published to by the loader, read by both.
//
// Before the list has been read (start-up, signed out) the store holds the list every computer is seeded with, so a
// label printed in that moment is the label it always was. Corrections this computer learned before the list
// existed fill in only colours the list does not name (legacyColorCorrections.ts).

type Listener = () => void;

interface ColorListState {
  readonly translations: readonly Pick<ColorTranslation, "englishName" | "urduName">[];
  readonly dictionary: ColorDictionary;
  /** The list, with this computer's older learned corrections beneath it: what labels and screens use. */
  readonly effective: ColorDictionary;
}

const withLegacy = (dictionary: ColorDictionary): ColorDictionary => {
  const effective = new Map(dictionary);
  for (const [key, urdu] of readLegacyColorCorrections()) {
    if (!effective.has(key)) effective.set(key, urdu);
  }
  return effective;
};

const stateOf = (translations: readonly Pick<ColorTranslation, "englishName" | "urduName">[]): ColorListState => {
  const dictionary = buildColorDictionary(translations);
  return { translations, dictionary, effective: withLegacy(dictionary) };
};

let state: ColorListState = stateOf(DEFAULT_COLOR_TRANSLATIONS.map((row) => ({ englishName: row.english, urduName: row.urdu })));
const listeners = new Set<Listener>();

/** Called by the loader with the list as read. Every subscribed screen re-renders once. */
export const publishColorTranslations = (translations: readonly ColorTranslation[]): void => {
  state = stateOf(translations);
  for (const listener of listeners) listener();
};

/** For plain functions (label printing): the dictionary as it stands now. */
export const currentColorDictionary = (): ColorDictionary => state.effective;

/** For plain functions: the list's rows, to read an Urdu colour back into English. */
export const currentColorTranslations = (): ColorListState["translations"] => state.translations;

const subscribe = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** For screens: the dictionary, re-rendering when the list changes. */
export const useColorDictionary = (): ColorDictionary => useSyncExternalStore(subscribe, () => state.effective);
