// The write domains of the single-writer model (docs/37 section W, owner decision 2026-10-23).
//
// One computer holds each domain's write lease and every other computer reads it. Carton and QR
// IDENTITY flows are deliberately absent: they stay multi-writer, because their identities are
// deduplicated by construction. The carton stock FIGURE is not an identity, and is leased (docs/42).
//
// Must match the rows cloud migrations 011 and 026 seed into lease_domains. cloudSchema.test.ts checks it.

export const LEASE_DOMAIN = {
  RAW_MATERIAL_STORE: "RAW_MATERIAL_STORE",
  MASTER_DATA: "MASTER_DATA",
  /** One domain, not two: a bill is locked to its gatepass. */
  SALES_DISPATCH: "SALES_DISPATCH",
  /** Also says where the vouchers are, so party ledger balances show only there. */
  ACCOUNTS: "ACCOUNTS",
  MACHINE_PROGRAMS: "MACHINE_PROGRAMS",
  APPROVALS: "APPROVALS",
  /**
   * Every movement of the carton figure: Manual Production and its voids, gatepass issues and their
   * cancels (docs/42 section 6, cloud 026). One writer, so no two computers can take the same cartons
   * out, and Manual Production's machine-day program and contractor ledger are never split.
   */
  CARTON_STOCK: "CARTON_STOCK",
} as const;

export type LeaseDomain = (typeof LEASE_DOMAIN)[keyof typeof LEASE_DOMAIN];
