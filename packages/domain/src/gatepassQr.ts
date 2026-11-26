// ─── Gatepass QR identity ────────────────────────────────────────────────────
// The QR printed on a sale voucher (owner, 26 Nov 2026): it says WHICH GATEPASS the bill was made from, so the ERP
// (and the phone app to come) opens that gatepass when it is scanned. It is the ERP's own code, not a web link: a
// phone's ordinary camera is not meant to open it, and nothing about the gatepass is published anywhere.
//
// Format: GPQR_<gatepass id>   (example: GPQR_3f2b9c1e-8a4d-4c55-9e1f-2a7b6c0d9e11)
//
// The gatepass's id, not its number: the id is the record itself, the same on every computer it travels to, and never
// renumbered. Two parts joined by one underscore, so it can never be read as a carton QR (four or six parts) or a raw
// material packet QR (RM_…, four parts).

export const GATEPASS_QR_PREFIX = "GPQR";

/** A gatepass id as the ERP makes them: letters, digits and dashes. */
const GATEPASS_QR_PATTERN = /^GPQR_([A-Za-z0-9-]{8,64})$/i;

export interface GatepassQrPayload {
  gatepassId: string;
}

/** The QR identity printed for one gatepass. */
export function buildGatepassQr(gatepassId: string): string {
  const id = String(gatepassId ?? "").trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error(`Not a gatepass id: "${id}"`);
  return `${GATEPASS_QR_PREFIX}_${id}`;
}

/**
 * The gatepass a scanned code names, or null when it is not a gatepass QR. A scanner that types into a field may send
 * the letters in either case, so the prefix is matched in any case and the id is returned in lower case, as the ERP
 * stores it.
 */
export function parseGatepassQr(rawInput: string): GatepassQrPayload | null {
  const match = GATEPASS_QR_PATTERN.exec(String(rawInput ?? "").trim());
  return match?.[1] ? { gatepassId: match[1].toLowerCase() } : null;
}
