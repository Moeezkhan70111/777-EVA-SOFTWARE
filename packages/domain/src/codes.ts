/**
 * Two numbered codes -- `PTY-000123`, `MP-1000000`, `RM-000045` -- in the order of their numbers.
 *
 * Compared as plain text, `PTY-1000000` comes before `PTY-200000`. Every code is six digits today,
 * so text order happens to be number order -- but blocks 11 to 99 number in seven digits
 * (docs/41 section 10), and the first of those would land at the top of every list. Runs of digits
 * are compared as numbers here, everything else as text.
 *
 * The SQL side of the same rule is orderByCode in @erp/data's numberRange.ts.
 */
export const compareNumberedCodes = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });
