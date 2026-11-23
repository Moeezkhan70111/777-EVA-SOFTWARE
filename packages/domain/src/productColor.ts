// WHEN TWO COLOUR SPELLINGS ARE THE SAME COLOUR.
//
// Product Master already treats "BLACK GREY", "BLACKGREY", "Black Grey" and "BLACK-GREY" as one colour when it registers
// a variant (products.ts resolveVariantForColor: upper case, spaces, dashes and underscores ignored). That rule only
// applies within one article + size, so two articles can still carry the colour spelled two ways. Anything that lays
// colours out side by side across articles -- the gatepass printout -- must match them by this same rule, or one colour
// gets two columns (owner, 23 Nov 2026: gatepass 200000 printed BLACK GREY twice).

/** The key two spellings of one colour share: upper case, with spaces, dashes and underscores removed. */
export const sameColourKey = (colour: string): string => colour.toUpperCase().replace(/[\s\-_]+/g, "");

/** A colour as it is printed: trimmed, inner spaces collapsed, upper case. */
export const printedColour = (colour: string): string => colour.trim().replace(/\s+/g, " ").toUpperCase();
