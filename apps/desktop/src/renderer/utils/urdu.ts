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

// ─── Colour attribute -> Urdu ───────────────────────────────────────────────────
// A material's Colour attribute is typed in English when the material is set up, but the raw
// material QR label prints it in Urdu for the factory floor. The floor's own word for a colour
// is often the English trade name written in Urdu script phonetically ("blue" -> "بلو"), not
// the literary Urdu word ("نیلا") — this dictionary is the owner's own list of what the floor
// actually calls each colour, not a dictionary translation.
const COLOR_NAME_URDU: Record<string, string> = {
  black: "سیاہ",
  blue: "بلو",
  brown: "براؤن",
  cream: "کریم",
  skin: "سکن",
  navy: "نیوی",
  red: "لال",
  orange: "اورنج",
  pink: "پنک",
  commando: "کمانڈو",
  army: "آرمی",
  green: "گرین",
  sky: "سکائ",
  white: "سفید",
  neon: "نیون",
  grey: "گرے",
  gray: "گرے",
  mustard: "مسٹرڈ",
};

const LEARNED_COLOR_URDU_KEY = "erp_learned_color_urdu_words";

const loadLearnedColorUrduWords = (): Record<string, string> => {
  try {
    const saved = window.localStorage.getItem(LEARNED_COLOR_URDU_KEY);
    const parsed = saved ? JSON.parse(saved) : {};
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
};

/**
 * Remembers a colour the dictionary above didn't name (or named wrongly) once an operator
 * corrects it by hand on a material — so the NEXT material in that colour, on this machine,
 * gets the correction as its own default instead of the same wrong guess again. Called from
 * NewMaterialModal whenever the Colour (Urdu) field was actually edited.
 */
export const learnColorUrdu = (englishColor: string, urduValue: string): void => {
  const key = englishColor.trim().toLowerCase();
  const urdu = urduValue.trim();
  if (!key || !urdu) return;
  const learned = loadLearnedColorUrduWords();
  learned[key] = urdu;
  try {
    window.localStorage.setItem(LEARNED_COLOR_URDU_KEY, JSON.stringify(learned));
  } catch {
    // Local storage may be unavailable in restricted test/browser contexts.
  }
};

/** One word's Urdu name, a learned correction winning over the dictionary — undefined if neither names it. */
const namedColorWord = (word: string, learned: Record<string, string>): string | undefined => learned[word] ?? COLOR_NAME_URDU[word];

/**
 * "BLACK" -> "سیاہ". A learned correction (see learnColorUrdu) wins over the dictionary above,
 * because it is a human's explicit "this one is wrong, it's actually this" — the whole point
 * of learning it.
 *
 * A compound colour ("CREAM MUSTARD") is named word by word when every word on its own is
 * known — "cream" + "mustard" -> "کریم مسٹرڈ" — rather than falling straight to phonetic
 * transliteration, which would spell the whole phrase out sound by sound ("کریام موسٹارڈ")
 * and miss the two colour names it is actually built from.
 *
 * A colour no part of this names still comes back in Urdu script — it falls back to the
 * phonetic transliteration above — rather than silently staying in English, since the point of
 * calling this is that the label must print Urdu.
 */
export const colorValueInUrdu = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || /[؀-ۿ]/.test(trimmed)) return trimmed; // empty, or already Urdu
  const normalized = trimmed.toLowerCase();
  const learned = loadLearnedColorUrduWords();

  const whole = namedColorWord(normalized, learned);
  if (whole) return whole;

  const words = normalized.split(/\s+/);
  if (words.length > 1) {
    const named = words.map((word) => namedColorWord(word, learned));
    if (named.every((word): word is string => Boolean(word))) return named.join(" ");
  }

  return transliterateToUrdu(trimmed);
};
