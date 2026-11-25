// Postel's law: be liberal in what the search accepts. A voucher is found as "RV-00001", "rv 1" or "rv1"; an amount
// as "353,880", "353880" or "Rs. 353,880". Every word typed must be found somewhere in the row, in any order.

/** Lower case, separators gone, leading zeros of a number gone: "RV-00001" and "rv1" both read "rv1". */
export const looseText = (value: string): string =>
  value.toLowerCase().replace(/rs\.?/g, "").replace(/[^a-z0-9]+/g, "").replace(/(^|[a-z])0+(?=\d)/g, "$1");

const wordsOf = (query: string): string[] => query.trim().split(/\s+/).filter(Boolean);

/** Whether every word of the query is in the row's values, read plainly or loosely. */
export function looseMatches(values: readonly string[], query: string): boolean {
  const words = wordsOf(query);
  if (words.length === 0) return true;
  const plain = values.join(" ").toLowerCase();
  const loose = values.map(looseText).join(" ");
  return words.every((word) => {
    const looseWord = looseText(word);
    // A word that is only "Rs." or punctuation says nothing to look for.
    return looseWord === "" || plain.includes(word.toLowerCase()) || loose.includes(looseWord);
  });
}

/** An amount as it may be typed: the whole rupees with no separators. */
export const amountText = (rupees: number): string => (rupees ? String(Math.round(Math.abs(rupees))) : "");
