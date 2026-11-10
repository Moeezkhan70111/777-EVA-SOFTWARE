import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COLOR_TRANSLATIONS } from "@erp/domain";
import { colorValueInEnglish, colorValueInUrdu, transliterateToUrdu, urduFieldValue, urduWhileTyping } from "./urdu";
import { publishColorTranslations } from "../features/colorTranslation/colorDictionaryStore";
import { LEGACY_COLOR_CORRECTIONS_KEY } from "../features/colorTranslation/legacyColorCorrections";

describe("Party name Urdu transliteration", () => {
  it("uses natural spellings for names, shop names, and cities", () => {
    expect(transliterateToUrdu("Ahmed Shoes Lahore")).toBe("احمد شوز لاہور");
    expect(transliterateToUrdu("Muhammad Ali Traders Karachi")).toBe("محمد علی ٹریڈرز کراچی");
    expect(transliterateToUrdu("Hassan Brothers Islamabad")).toBe("حسن برادرز اسلام آباد");
  });

  it("handles common Pakistani names and business terms without changing words", () => {
    expect(transliterateToUrdu("Faisal Garments Faisalabad")).toBe("فیصل گارمنٹس فیصل آباد");
    expect(transliterateToUrdu("Bata Footwear Rawalpindi")).toBe("باٹا فٹ وئیر راولپنڈی");
    expect(transliterateToUrdu("Ali Store, Karachi")).toBe("علی اسٹور, کراچی");
  });
});

// What an Urdu field (UrduInput) does with what the desk types on an ordinary keyboard.
describe("Typing Urdu on an English keyboard", () => {
  it("leaves the word being typed alone and converts it once it is finished", () => {
    expect(urduWhileTyping("ahm")).toBe("ahm");
    expect(urduWhileTyping("ahmed")).toBe("ahmed");
    // The space finishes the word: the whole word is spelled, not one letter at a time.
    expect(urduWhileTyping("ahmed ")).toBe("احمد ");
    expect(urduWhileTyping("احمد al")).toBe("احمد al");
    expect(urduWhileTyping("احمد ali ")).toBe("احمد علی ");
  });

  it("finishes the last word when the field is left", () => {
    expect(urduFieldValue("احمد ali")).toBe("احمد علی");
    expect(urduFieldValue("ahmed shoes")).toBe("احمد شوز");
  });

  it("leaves Urdu that was typed or pasted straight in exactly as it is", () => {
    expect(urduWhileTyping("احمد شوز لاہور")).toBe("احمد شوز لاہور");
    expect(urduFieldValue("احمد شوز لاہور")).toBe("احمد شوز لاہور");
    expect(urduFieldValue("")).toBe("");
  });
});

describe("Colour attribute Urdu translation", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("names every colour on the floor's own list, in any casing", () => {
    expect(colorValueInUrdu("Black")).toBe("سیاہ");
    expect(colorValueInUrdu("blue")).toBe("بلو");
    expect(colorValueInUrdu("BROWN")).toBe("براؤن");
    expect(colorValueInUrdu("Cream")).toBe("کریم");
    expect(colorValueInUrdu("skin")).toBe("سکن");
    expect(colorValueInUrdu("Navy")).toBe("نیوی");
    expect(colorValueInUrdu("red")).toBe("لال");
    expect(colorValueInUrdu("Orange")).toBe("اورنج");
    expect(colorValueInUrdu("PINK")).toBe("پنک");
    expect(colorValueInUrdu("Commando")).toBe("کمانڈو");
    expect(colorValueInUrdu("army")).toBe("آرمی");
    expect(colorValueInUrdu("Green")).toBe("گرین");
    expect(colorValueInUrdu("sky")).toBe("سکائ");
    expect(colorValueInUrdu("White")).toBe("سفید");
    expect(colorValueInUrdu("Neon")).toBe("نیون");
    expect(colorValueInUrdu("grey")).toBe("گرے");
    expect(colorValueInUrdu("gray")).toBe("گرے");
    expect(colorValueInUrdu("Mustard")).toBe("مسٹرڈ");
  });

  it("names a compound colour word by word when every word is individually known", () => {
    expect(colorValueInUrdu("Cream Mustard")).toBe("کریم مسٹرڈ");
    expect(colorValueInUrdu("SKY BLUE")).toBe("سکائ بلو");
  });

  // A carton's QR identity folds "BLACK RED" onto "BLACKRED" (normalizeQrColor), so the
  // sticker only ever sees the run-together spelling.
  it("names a compound colour written without a space, as a carton QR identity holds it", () => {
    expect(colorValueInUrdu("BLACKRED")).toBe("سیاہ لال");
    expect(colorValueInUrdu("SkyBlue")).toBe("سکائ بلو");
    expect(colorValueInUrdu("ARMYGREEN")).toBe("آرمی گرین");
  });

  it("leaves a run-together colour it cannot fully name to phonetic transliteration", () => {
    const result = colorValueInUrdu("BLUEBERRY");
    expect(result).not.toContain("بلو ");
    expect(/[؀-ۿ]/.test(result)).toBe(true);
  });

  it("falls back to phonetic transliteration for a compound where one word is not known", () => {
    const result = colorValueInUrdu("Light Mustard");
    expect(result).not.toBe("مسٹرڈ");
    expect(/[؀-ۿ]/.test(result)).toBe(true);
  });

  it("still returns Urdu script for a colour the list does not name", () => {
    const result = colorValueInUrdu("Chartreuse");
    expect(result).not.toBe("Chartreuse");
    expect(/[؀-ۿ]/.test(result)).toBe(true);
  });

  it("leaves Urdu already in the field untouched, and empty values empty", () => {
    expect(colorValueInUrdu("سیاہ")).toBe("سیاہ");
    expect(colorValueInUrdu("")).toBe("");
    expect(colorValueInUrdu("   ")).toBe("");
  });
});

describe("the shared colour list drives the labels", () => {
  const seeded = DEFAULT_COLOR_TRANSLATIONS.map((row, index) => ({ id: `c-${String(index)}`, englishName: row.english, urduName: row.urdu }));

  beforeEach(() => {
    window.localStorage.clear();
    publishColorTranslations(seeded);
  });

  it("follows the list as it is edited: a changed Urdu prints, a removed colour is spelled out", () => {
    publishColorTranslations(seeded.map((row) => (row.englishName === "Black" ? { ...row, urduName: "کالا" } : row)).filter((row) => row.englishName !== "Sky"));
    expect(colorValueInUrdu("BLACK")).toBe("کالا");
    expect(colorValueInUrdu("sky")).not.toBe("سکائ");
    expect(/[؀-ۿ]/.test(colorValueInUrdu("sky"))).toBe(true);
  });

  it("names the owner's new colours", () => {
    expect(colorValueInUrdu("Yellow")).toBe("پیلا");
    expect(colorValueInUrdu("ARMY GREEN")).toBe("آرمی گرین");
    expect(colorValueInUrdu("coffee")).toBe("کافی");
    expect(colorValueInUrdu("LIGHT")).toBe("لایٹ");
    expect(colorValueInUrdu("dark")).toBe("ڈارک");
  });

  it("keeps a correction this computer learned before the list, only where the list names nothing", () => {
    window.localStorage.setItem(LEGACY_COLOR_CORRECTIONS_KEY, JSON.stringify({ maroon: "گہرا مرون", black: "کالا" }));
    publishColorTranslations(seeded);
    expect(colorValueInUrdu("Maroon")).toBe("گہرا مرون");
    expect(colorValueInUrdu("BLACK")).toBe("سیاہ");
  });

  it("reads an Urdu colour back into the list's English, in capitals", () => {
    expect(colorValueInEnglish("سیاہ")).toBe("BLACK");
    expect(colorValueInEnglish("آرمی گرین")).toBe("ARMY GREEN");
    expect(colorValueInEnglish("گرے")).toBeUndefined();
    expect(colorValueInEnglish("گرے", ["BLACK", "GREY"])).toBe("GREY");
    expect(colorValueInEnglish("نیلا")).toBeUndefined();
  });
});
