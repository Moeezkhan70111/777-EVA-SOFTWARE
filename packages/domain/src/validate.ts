// Runtime narrowing for data that crosses a trust boundary (IPC input from the renderer,
// sync payloads, imported files). TypeScript types do not validate at runtime; these
// helpers do, without a schema library. Each returns a safe default for absent values
// and `undefined` for the optional variants, so callers never see NaN or "undefined".

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

export const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);

export const asTrimmedString = (value: unknown, fallback = ""): string => asString(value, fallback).trim();

export const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

export const asNullableString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

export const asNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
};

export const asOptionalNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = asNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const asNullableNumber = (value: unknown): number | null => asOptionalNumber(value) ?? null;

export const asPositiveInteger = (value: unknown, fallback: number): number => {
  const parsed = asNumber(value, Number.NaN);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const asBoolean = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

export const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Keeps only the string-valued entries of a record (e.g. attribute filters). */
export const asStringRecord = (value: unknown): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === "string") output[key] = entry;
  }
  return output;
};

/** Narrows to one of the allowed literal values, or the fallback. */
export const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** Narrows to one of the allowed literal values, or `undefined`. */
export const optionalOneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
