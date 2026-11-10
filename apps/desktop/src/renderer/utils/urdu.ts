import { colorToUrdu, urduToEnglish } from "@erp/domain";
import { currentColorDictionary, currentColorTranslations } from "../features/colorTranslation/colorDictionaryStore";

// Roman → Urdu typing.
//
// The desk types a name the way it sounds on an ordinary English keyboard and the Urdu
// letters appear as it goes, so no one has to switch keyboard layouts mid-bill. Used by
// the party form (party name in Urdu) and by the bill's Urdu fields through UrduInput.
//
// Names the dictionary does not know are spelled out sound by sound; corrections made on
// a party are remembered locally so the same word comes out right next time.

const URDU_WORDS: Record<string, string> = {
  shoes: "شوز", shoe: "شوز", chappal: "چپل", traders: "ٹریڈرز", trader: "ٹریڈرز", brothers: "برادرز", brother: "برادر",
  committee: "کمیٹی", packages: "پیکیجز", package: "پیکیجز", timber: "ٹمبر",
  "timber market": "ٹمبر مارکیٹ", "shah alam market": "شاہ عالم مارکیٹ", footwear: "فٹ وئیر",
  rubber: "ربڑ", chemical: "کیمیکل", chemicals: "کیمیکلز", lamination: "لامیناشن",
  laminations: "لیمینیشن", compound: "کمپاونڈ", eva: "ایوا", evr: "ای وی آر",
  accessories: "اسیسرییس", buckle: "بکل", diesel: "ڈیزل", cargo: "کارگو", logistics: "لوجیسٹکس", store: "اسٹور", stores: "اسٹورز", garments: "گارمنٹس",
  packing: "پیکنگ", machine: "مشین", sticker: "سٹیکر", maker: "میکر", flower: "پھول",
  auto: "آٹو", kapra: "کپڑا", tag: "ٹیگ", maal: "مال", patta: "پٹہ", "dye maker": "ڈائ میکر",
  "rubber topping": "ربڑ ٹوپنگ", "rubber toping": "ربڑم ٹوپنگ",
  ahmad: "احمد", ahmed: "احمد", ali: "علی", faisal: "فیصل", abdul: "عبدل", ghani: "غنی", adeel: "عدیل", khursheed: "خورشید",
  ameer: "امیر", saeed: "سعید", aqeel: "عقیل", ashraf: "اشرف", asif: "آصف", ayoob: "ایوب",
  azhar: "اظہر", azan: "اذان", babu: "بابُو", rado: "راڈو", chaand: "چاند", chaudhry: "چودھری",
  chawla: "چاولہ", daniyal: "دانیال", dilawar: "دلاور", dost: "دوست", muhammad: "محمد", hameed: "حمید",
  sons: "سنز", hassan: "حسن", tariq: "طارق", irfan: "عرفان", islam: "اسلام", khan: "خان", junaid: "جنید",
  kaleem: "کلیم", keshu: "کیشو", laal: "لال", lateef: "لطیف", gull: "گل", mahfooz: "محفوظ", maheen: "ماہین",
  malik: "ملک", muneer: "منیر", muqeem: "مقیم", muzammil: "مزمل", ansar: "انصر", hafiz: "حافظ", rizwan: "رضوان",
  salman: "سلمان", nouman: "نعمان", owais: "اویس", butt: "بٹ", qasim: "قاسم", anwaar: "انوار", qurban: "قربان",
  raja: "راجہ", ranyal: "رانیال", saad: "سعد", sadam: "صدام", sahib: "صاحب", sajjad: "سجاد", shah: "شاہ",
  shaheena: "شاہینہ", shahid: "شاہد", shahzad: "شہزاد", shehzad: "شہزاد", sheikh: "شیخ", shoukat: "شوکت",
  subhan: "سبحان", sundas: "سندس", taj: "تاج", tanveer: "تنویر", usman: "عثمان", ubaid: "عبید", usama: "اسامہ",
  umer: "عمر", fayyaz: "فیاز", touqeer: "توقیر", shehroz: "شہروز", tycoon: "ٹایکون", volvo: "والوو",
  waqar: "وقار", yusuf: "یوسف", zayyam: "زیام", zeeshan: "ذٰیشان", zohaib: "زوہیب", zubair: "زبیر", iqbal: "اقبال",
  karachi: "کراچی", lahore: "لاہور", islamabad: "اسلام آباد", larkana: "لاڑکانہ", hyderabad: "حیدرآباد", sukkur: "سکھر", rawalpindi: "راولپنڈی",
  faisalabad: "فیصل آباد", multan: "ملتان", gujranwala: "گوجرانوالہ", gujrat: "گجرات", sialkot: "سیالکوٹ", peshawar: "پشاور",
  "shahdad kot": "شاحداد کوٹ", shabqadar: "شبقدر", "lala musa": "لالہ موسیٰ", "dera ismail khan": "ڈیرا اسماعیل خان",
  "raheem yar khan": "رحیم یار خان", "moti bazar": "موتی بازار", "peer mahal": "پیر محل", "shakar garh": "شکر گڑھ",
  samriyal: "سمڑیال", nekia: "نکیاں", mama: "ماما",
};

const URDU_PHRASES = Object.entries(URDU_WORDS)
  .filter(([key]) => key.includes(" "))
  .sort(([left], [right]) => right.length - left.length);

const URDU_LETTERS: Record<string, string> = {
  a: "ا", b: "ب", c: "ک", d: "ڈ", e: "ی", f: "ف", g: "گ", h: "ہ", i: "ی", j: "ج",
  k: "ک", l: "ل", m: "م", n: "ن", o: "و", p: "پ", q: "ق", r: "ر", s: "س", t: "ٹ",
  u: "و", v: "و", w: "و", x: "کس", y: "ی", z: "ز",
};

const URDU_SOUNDS: Array<[string, string]> = [
  ["ch", "چ"], ["sh", "ش"], ["kh", "خ"], ["gh", "غ"], ["ph", "ف"], ["bh", "بھ"],
  ["dh", "دھ"], ["th", "تھ"], ["aa", "ا"], ["ee", "ی"], ["ii", "ی"],
  ["oo", "و"], ["uu", "و"], ["ai", "ے"], ["ay", "ے"], ["ou", "و"],
];

export const transliterateToUrdu = (value: string): string => value
  .replace(/\b[^\s]+(?:\s+[^\s]+)+\b/gi, (phrase) => {
    const normalized = phrase.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
    const match = URDU_PHRASES.find(([key]) => key === normalized);
    return match ? match[1] : phrase;
  })
  .split(/(\s+)/)
  .map((part) => {
    if (/^\s+$/.test(part) || !part) return part;
    const match = part.match(/^([^a-zA-Z0-9]*)([a-zA-Z0-9]+)([^a-zA-Z0-9]*)$/);
    if (!match) return part;
    const [, prefix, word, suffix] = match;
    const normalized = word.toLowerCase();
    if (URDU_WORDS[normalized]) return `${prefix}${URDU_WORDS[normalized]}${suffix}`;
    let result = "";
    let index = 0;
    while (index < normalized.length) {
      const sound = URDU_SOUNDS.find(([latin]) => normalized.startsWith(latin, index));
      if (sound) {
        result += sound[1];
        index += sound[0].length;
      } else {
        result += URDU_LETTERS[normalized[index]] ?? normalized[index];
        index += 1;
      }
    }
    return `${prefix}${result}${suffix}`;
  })
  .join("");

const LEARNED_URDU_WORDS_KEY = "erp_learned_party_urdu_words";

const normalizePartyName = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

const loadLearnedUrduWords = (): Record<string, string> => {
  try {
    const saved = window.localStorage.getItem(LEARNED_URDU_WORDS_KEY);
    const parsed = saved ? JSON.parse(saved) : {};
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
};

export const learnUrduWords = (englishName: string, urduName: string) => {
  const englishWords = englishName.match(/[a-z0-9]+/gi) ?? [];
  const urduWords = urduName.trim().split(/\s+/).filter((word) => /[\u0600-\u06ff]/i.test(word));
  if (!englishWords.length || englishWords.length !== urduWords.length) return;
  const learnedWords = loadLearnedUrduWords();
  englishWords.forEach((englishWord, index) => {
    const key = normalizePartyName(englishWord).replace(/[^a-z0-9]/g, "");
    const translatedWord = urduWords[index]?.trim();
    if (key && translatedWord) learnedWords[key] = translatedWord;
  });
  try {
    window.localStorage.setItem(LEARNED_URDU_WORDS_KEY, JSON.stringify(learnedWords));
  } catch {
    // Local storage may be unavailable in restricted test/browser contexts.
  }
};

export const transliterateWithLearnedWords = (value: string): string => {
  const learnedWords = loadLearnedUrduWords();
  return value.split(/(\s+)/).map((part) => {
    if (/^\s+$/.test(part) || !part) return part;
    const match = part.match(/^([^a-zA-Z0-9]*)([a-zA-Z0-9]+)([^a-zA-Z0-9]*)$/);
    if (!match) return part;
    const [, prefix, word, suffix] = match;
    const learned = learnedWords[normalizePartyName(word)];
    return learned ? `${prefix}${learned}${suffix}` : transliterateToUrdu(part);
  }).join("");
};

export const transliterateRomanSegments = (value: string): string => value
  .split(/([A-Za-z0-9]+)/)
  .map((part) => /[A-Za-z0-9]/.test(part) ? transliterateToUrdu(part) : part)
  .join("");

/** What an Urdu field holds once everything typed into it is finished: all roman turned into Urdu. */
export const urduFieldValue = (typed: string): string => (/[A-Za-z0-9]/.test(typed) ? transliterateRomanSegments(typed) : typed);

/**
 * What an Urdu field shows while it is still being typed. A word turns into Urdu only once
 * it is finished — the word in progress is left in roman letters. A whole word can then be
 * looked up and spelled properly ("ahmed" → احمد), which letter-by-letter conversion cannot
 * do: it would never see more than one letter at a time (ا, ہ, م, د).
 */
export const urduWhileTyping = (typed: string): string => {
  const match = typed.match(/^([\s\S]*\s)(\S*)$/);
  if (!match) return typed; // still on the first word
  const [, finished, inProgress] = match;
  return `${urduFieldValue(finished)}${inProgress}`;
};

// ─── Colour -> Urdu ───────────────────────────────────────────────────────────────
// A colour is stored in English everywhere; the carton sticker and the raw material label print it in Urdu for the
// factory floor. What the floor calls each colour is the shared colour list (master data, the Color Translation
// page, docs/45), resolved by @erp/domain's colorToUrdu -- whole names, compounds word by word, and run-together
// carton colours ("BLACKRED") piece by piece. This used to be a dictionary written here; its entries are seeded
// into that list on every computer, so no label changes.

/**
 * "BLACK" -> "سیاہ", for a label. A colour the list does not name still comes back in Urdu script -- spelled out
 * sound by sound -- because a label must print Urdu. A screen that should show the English instead uses
 * colorForDisplay (@erp/domain) with useColorDictionary.
 */
export const colorValueInUrdu = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return colorToUrdu(trimmed, currentColorDictionary()) ?? transliterateToUrdu(trimmed);
};

/**
 * "سیاہ" -> "BLACK": an Urdu colour typed where an English one is expected, read back to the list's English, in
 * capitals as colour attributes are stored. Undefined when the list does not name it, or names it twice
 * ("گرے" is Grey and Gray) and `allowed` -- the English values a field offers -- does not settle which.
 */
export const colorValueInEnglish = (value: string, allowed?: readonly string[]): string | undefined => {
  const match = urduToEnglish(value, currentColorTranslations(), allowed);
  return match.status === "FOUND" ? match.english.toUpperCase() : undefined;
};
