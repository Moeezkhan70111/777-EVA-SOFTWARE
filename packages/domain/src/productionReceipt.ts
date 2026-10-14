// Receive Production — recording a carton as produced by scanning its generated carton QR (Phase 2).
//
// One scan is one carton. A carton is received ONCE, and only if its QR was generated and persisted
// by the QR Generator: a value that merely looks like a carton QR proves nothing. Every scan attempt
// ends in exactly one of these outcomes, which the main process decides and the screen only shows.

export const RECEIVE_PRODUCTION_OUTCOME = {
  /** Recorded now: the carton is produced. */
  RECEIVED: "RECEIVED",
  /** Produced before (here, at Live Production, or at Store In) — nothing new is recorded. */
  ALREADY_RECEIVED: "ALREADY_RECEIVED",
  /** A well-formed carton QR the generator never registered. */
  NOT_GENERATED: "NOT_GENERATED",
  /** A raw material label — never a carton. */
  RAW_MATERIAL_QR: "RAW_MATERIAL_QR",
  /** Not a carton QR at all: malformed, empty or unreadable. */
  INVALID_QR: "INVALID_QR",
  /** Registered, but voided in QR Management (or replaced by a B carton label). */
  INELIGIBLE: "INELIGIBLE",
  /** The operation failed; nothing is known to have been recorded. */
  ERROR: "ERROR",
} as const;
export type ReceiveProductionOutcome = (typeof RECEIVE_PRODUCTION_OUTCOME)[keyof typeof RECEIVE_PRODUCTION_OUTCOME];

/** What a PRODUCED event's metadata calls this station, so its receipts can be told apart. */
export const RECEIVE_PRODUCTION_STATION = "RECEIVE_PRODUCTION";
