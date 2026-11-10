import test from "node:test";
import assert from "node:assert/strict";
import {
  COLOR_TRANSLATION_ERROR,
  DEFAULT_COLOR_DICTIONARY,
  DEFAULT_COLOR_TRANSLATIONS,
  buildColorDictionary,
  colorForDisplay,
  colorToUrdu,
  normalizeColorKey,
  seededColorTranslationId,
  urduToEnglish,
  validateColorTranslation,
} from "./colorTranslation.js";

// The owner's list of 2026-11-10, exactly as supplied.
const OWNER_LIST: ReadonlyArray<[string, string]> = [
  ["Black", "سیاہ"], ["Navy", "نیوی"], ["Blue", "بلو"], ["Yellow", "پیلا"], ["Neon", "نیون"],
  ["Red", "لال"], ["Grey", "گرے"], ["Orange", "اورنج"], ["Commando", "کمانڈو"], ["Army Green", "آرمی گرین"],
  ["Pink", "پنک"], ["Coffee", "کافی"], ["Light", "لایٹ"], ["Dark", "ڈارک"], ["White", "سفید"],
];

// The raw material label's dictionary before this list existed (renderer utils/urdu.ts, COLOR_NAME_URDU).
const LABEL_DICTIONARY: ReadonlyArray<[string, string]> = [
  ["black", "سیاہ"], ["blue", "بلو"], ["brown", "براؤن"], ["cream", "کریم"], ["skin", "سکن"], ["navy", "نیوی"],
  ["red", "لال"], ["orange", "اورنج"], ["pink", "پنک"], ["commando", "کمانڈو"], ["army", "آرمی"], ["green", "گرین"],
  ["sky", "سکائ"], ["white", "سفید"], ["neon", "نیون"], ["grey", "گرے"], ["gray", "گرے"], ["mustard", "مسٹرڈ"],
];

const rows = DEFAULT_COLOR_TRANSLATIONS.map((row) => ({ englishName: row.english, urduName: row.urdu }));

test("all fifteen of the owner's translations, spelled exactly as supplied", () => {
  for (const [english, urdu] of OWNER_LIST) {
    assert.equal(colorToUrdu(english, DEFAULT_COLOR_DICTIONARY), urdu, english);
    assert.equal(colorToUrdu(english.toUpperCase(), DEFAULT_COLOR_DICTIONARY), urdu, `${english} in capitals`);
  }
});

test("every translation the raw material label already had is kept", () => {
  for (const [english, urdu] of LABEL_DICTIONARY) assert.equal(colorToUrdu(english, DEFAULT_COLOR_DICTIONARY), urdu, english);
  assert.equal(DEFAULT_COLOR_TRANSLATIONS.length, 23, "15 supplied + 8 the label had that the owner's list does not");
});

test("the two lists never disagree, so nothing was overwritten in the merge", () => {
  const owner = new Map(OWNER_LIST.map(([english, urdu]) => [normalizeColorKey(english), urdu]));
  for (const [english, urdu] of LABEL_DICTIONARY) {
    const supplied = owner.get(english);
    if (supplied !== undefined) assert.equal(supplied, urdu, `${english}: one spelling`);
  }
});

test("English keys are case-insensitive and whitespace-safe", () => {
  assert.equal(normalizeColorKey("  Army   GREEN "), "army green");
  assert.equal(colorToUrdu(" army  green ", DEFAULT_COLOR_DICTIONARY), "آرمی گرین");
  assert.equal(seededColorTranslationId("Army Green"), "color:army-green");
});

test("compounds are named word by word, and run-together carton colours piece by piece", () => {
  assert.equal(colorToUrdu("CREAM MUSTARD", DEFAULT_COLOR_DICTIONARY), "کریم مسٹرڈ");
  assert.equal(colorToUrdu("BLACKRED", DEFAULT_COLOR_DICTIONARY), "سیاہ لال");
  assert.equal(colorToUrdu("ARMY GREEN CREAM", DEFAULT_COLOR_DICTIONARY), "آرمی گرین کریم");
});

test("an unknown colour is unknown, and a screen falls back to the colour as stored", () => {
  assert.equal(colorToUrdu("BLUEBERRY", DEFAULT_COLOR_DICTIONARY), undefined);
  assert.equal(colorToUrdu("BLACK MITALIC", DEFAULT_COLOR_DICTIONARY), undefined);
  assert.equal(colorForDisplay("MITALIC", DEFAULT_COLOR_DICTIONARY), "MITALIC");
  assert.equal(colorForDisplay("BLACK", DEFAULT_COLOR_DICTIONARY), "سیاہ");
  assert.equal(colorToUrdu("", DEFAULT_COLOR_DICTIONARY), undefined);
  assert.equal(colorToUrdu("سیاہ", DEFAULT_COLOR_DICTIONARY), "سیاہ", "already Urdu");
});

test("Urdu resolves back to its English name; Grey and Gray share one Urdu, so a field's own options decide", () => {
  for (const [english, urdu] of OWNER_LIST.filter(([english]) => english !== "Grey")) {
    assert.deepEqual(urduToEnglish(urdu, rows), { status: "FOUND", english }, urdu);
  }
  assert.deepEqual(urduToEnglish("گرے", rows), { status: "AMBIGUOUS", candidates: ["Grey", "Gray"] });
  assert.deepEqual(urduToEnglish("گرے", rows, ["BLACK", "GREY"]), { status: "FOUND", english: "Grey" });
  assert.deepEqual(urduToEnglish(" سیاہ  لال ", rows), { status: "FOUND", english: "Black Red" });
  assert.deepEqual(urduToEnglish("نیلا", rows), { status: "UNKNOWN" });
});

test("a list that changes is what the lookups follow", () => {
  const edited = buildColorDictionary([{ englishName: "Black", urduName: "کالا" }]);
  assert.equal(colorToUrdu("black", edited), "کالا");
  assert.equal(colorToUrdu("red", edited), undefined);
});

test("an entry is validated with a reason a person can act on", () => {
  assert.equal(validateColorTranslation("", "سیاہ"), COLOR_TRANSLATION_ERROR.ENGLISH_REQUIRED);
  assert.equal(validateColorTranslation("سیاہ", "سیاہ"), COLOR_TRANSLATION_ERROR.ENGLISH_NOT_LATIN);
  assert.equal(validateColorTranslation("Black", " "), COLOR_TRANSLATION_ERROR.URDU_REQUIRED);
  assert.equal(validateColorTranslation("Black", "Black"), COLOR_TRANSLATION_ERROR.URDU_NOT_URDU);
  assert.equal(validateColorTranslation("A".repeat(61), "سیاہ"), COLOR_TRANSLATION_ERROR.ENGLISH_TOO_LONG);
  assert.equal(validateColorTranslation("S-Pink", "ایس پنک"), null);
});
