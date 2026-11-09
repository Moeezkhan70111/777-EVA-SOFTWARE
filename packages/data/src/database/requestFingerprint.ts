// What one press of Save asked for, as a short hash (migration 105).
//
// A retry whose answer was lost comes back under the same request id. If it asks for the same thing, the
// document it already made is the answer; if it asks for something else, that is a conflict, never a silent
// "saved". The hash is taken over a canonical form, so field order, line order and spacing do not matter,
// and money is compared in paisa, never as a floating rupee figure.

import { createHash } from "node:crypto";

/** A request id as the screens make them: crypto.randomUUID(). */
export const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isRequestId = (value: unknown): value is string => typeof value === "string" && REQUEST_ID.test(value.trim());

type Canonical = string | number | boolean | null | Canonical[] | { [key: string]: Canonical };

/** Objects with their keys sorted, so `{a, b}` and `{b, a}` hash the same. Arrays keep their order. */
const canonical = (value: Canonical): Canonical => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key] as Canonical)]));
  }
  return value;
};

/** SHA-256 of the canonical JSON of `value`. */
export const requestFingerprint = (value: Canonical): string =>
  createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

/** Trimmed text, or null for nothing, so "" and "  " and null ask for the same thing. */
export const fingerprintText = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Lines sorted by a key, so the same lines in another order ask for the same thing. */
export const sortedLines = <T extends Record<string, Canonical>>(lines: readonly T[], key: (line: T) => string): T[] =>
  [...lines].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** Thrown when a request id already made a document that asked for something else. */
export class RequestConflictError extends Error {
  readonly code = "REQUEST_CONFLICT";
  constructor(
    message: string,
    readonly existing: { id: string; number: string }
  ) {
    super(message);
    this.name = "RequestConflictError";
  }
}
