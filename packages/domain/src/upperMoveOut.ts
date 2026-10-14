// Upper Move Out — issuing an upper packet out of the store to a named machine (Phase 3).
//
// An "upper carton" is a raw material packet: a labelled packet (RM_… QR) of a material whose
// top-level category is UPPER (RAW_MATERIAL_KIND.UPPER), received into the store on Raw Material
// Input and counted in that material's stock balance in its own unit (DOZEN, PAIR …). It is NOT a
// finished-goods carton QR — those are the QR Generator's and are refused here by name.
//
// Every scan attempt ends in exactly one of these outcomes, decided by the main process.

export const UPPER_ISSUE_OUTCOME = {
  /** Issued: the packet left the store for the machine, and its stock is debited. */
  ISSUED: "ISSUED",
  /** No machine was named. */
  MACHINE_REQUIRED: "MACHINE_REQUIRED",
  /** The machine named does not exist, or is retired. */
  MACHINE_INELIGIBLE: "MACHINE_INELIGIBLE",
  /** A finished-goods carton QR — those are received, not issued as uppers. */
  FINISHED_CARTON: "FINISHED_CARTON",
  /** A raw material packet, but not an upper (Dana, …). */
  NOT_UPPER: "NOT_UPPER",
  /** Not a QR this station can read at all. */
  INVALID_QR: "INVALID_QR",
  /** A well-formed raw material QR that was never generated. */
  UNKNOWN_QR: "UNKNOWN_QR",
  /** Generated, but never received into the store. */
  NOT_IN_STORE: "NOT_IN_STORE",
  /** Already issued out of the store. */
  ALREADY_ISSUED: "ALREADY_ISSUED",
  /** Voided, or otherwise not issuable. */
  INELIGIBLE: "INELIGIBLE",
  /** The material has no packing, so there is no quantity to take off its stock. */
  NOT_CONFIGURED: "NOT_CONFIGURED",
  /** Issuing it would take the material's stock below zero. */
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  /** Another terminal issued this packet at the same moment. */
  CONCURRENT_ISSUE: "CONCURRENT_ISSUE",
  /** The operation failed; nothing is known to have been issued. */
  ERROR: "ERROR",
} as const;
export type UpperIssueOutcome = (typeof UPPER_ISSUE_OUTCOME)[keyof typeof UPPER_ISSUE_OUTCOME];
