import { InvalidQrError } from "./qr.js";

// ─── Raw Material QR identity ─────────────────────────────────────────────────
// Raw material QR codes identify a (supplier, item) receiving lot, not a finished-good
// article/color/size — there is no size fraction to encode — so they use their own format
// and their own registry tables (see migrations/sqlite/036_raw_material_qr), separate from
// the finished-goods QrParserV1/buildQrId in ./qr.ts.
//
// Format (current, v2): RM_PARTYTOKEN_ITEMTOKEN_SERIAL (example: RM_6_42_6)
//
// party_code/item_code are always their own zero-padded code ("PTY-000006", "RM-000042") —
// embedding them in full made the old identity long enough to hurt scan reliability at label
// print size. The party/item are already uniquely identified by the numeric tail of their
// code, so v2 embeds only that (with the padding stripped) instead of the whole code, and
// leaves the serial unpadded too. This is a shorter encoding of the exact same (party, item,
// sequence) triple, so uniqueness is unchanged.
//
// Format (legacy, v1 — still accepted when scanning): RMQR_PARTYCODE_ITEMCODE_SERIAL
// (example: RMQR_PTY000001_RM000042_000006). Labels already printed under v1 must keep
// scanning, so isValidRawMaterialQrId/parseRawMaterialQrId still recognize it; only the
// generator (buildRawMaterialQrId) has moved to v2.

export const RAW_MATERIAL_QR_PREFIX = "RM";
export const RAW_MATERIAL_QR_LEGACY_PREFIX = "RMQR";
/** Legacy (v1) display padding only — v2 identities embed the serial unpadded. */
export const RAW_MATERIAL_QR_SERIAL_WIDTH = 6;

const RAW_MATERIAL_QR_CODE_PATTERN = /^[A-Z0-9]+$/;
const RAW_MATERIAL_QR_PATTERN_V2 = /^RM_([A-Z0-9]+)_([A-Z0-9]+)_([0-9]+)$/;
const RAW_MATERIAL_QR_PATTERN_V1 = /^RMQR_([A-Z0-9]+)_([A-Z0-9]+)_([0-9]+)$/;

export interface RawMaterialQrIdentityParts {
  partyCode: string;
  itemCode: string;
  sequence: number;
}

export interface RawMaterialQrPayload {
  qrId: string;
  partyCode: string;
  itemCode: string;
  serial: string;
}

/** Folds a party/item code's punctuation and casing onto one logical identity: "PTY-000001" -> "PTY000001". */
export function normalizeRawMaterialQrCode(rawCode: string): string {
  return String(rawCode ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Shortens a normalized party/item code to the token embedded in a v2 QR identity: just its
 * numeric tail with the zero-padding stripped ("PTY000006" -> "6"). The code's own row is
 * already the unique thing — the letters and padding exist only for the code's own display —
 * so dropping them loses nothing. Falls back to the full normalized code on the (currently
 * never hit) case of a code with no digits, so the identity stays buildable either way.
 */
export function compactRawMaterialQrToken(normalizedCode: string): string {
  const digits = normalizedCode.match(/([0-9]+)$/)?.[1];
  return digits ? String(Number(digits)) : normalizedCode;
}

export function formatRawMaterialQrSerial(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new InvalidQrError("RAW_MATERIAL_QR_SERIAL_INVALID", "Serial must be a positive whole number.");
  }
  return String(sequence);
}

/**
 * Builds the canonical v2 `RM_PARTYTOKEN_ITEMTOKEN_SERIAL` identity. Throws InvalidQrError
 * when a part cannot be encoded — the generator must never register an identity it cannot
 * parse back.
 */
export function buildRawMaterialQrId(parts: RawMaterialQrIdentityParts): string {
  const partyCode = normalizeRawMaterialQrCode(parts.partyCode);
  const itemCode = normalizeRawMaterialQrCode(parts.itemCode);

  if (!RAW_MATERIAL_QR_CODE_PATTERN.test(partyCode)) {
    throw new InvalidQrError(
      "RAW_MATERIAL_QR_PARTY_INVALID",
      `Party code "${parts.partyCode}" cannot be encoded. Use letters and digits only.`
    );
  }
  if (!RAW_MATERIAL_QR_CODE_PATTERN.test(itemCode)) {
    throw new InvalidQrError(
      "RAW_MATERIAL_QR_ITEM_INVALID",
      `Item code "${parts.itemCode}" cannot be encoded. Use letters and digits only.`
    );
  }

  const partyToken = compactRawMaterialQrToken(partyCode);
  const itemToken = compactRawMaterialQrToken(itemCode);

  return `${RAW_MATERIAL_QR_PREFIX}_${partyToken}_${itemToken}_${formatRawMaterialQrSerial(parts.sequence)}`;
}

export function isValidRawMaterialQrId(rawInput: string): boolean {
  const input = rawInput.trim();
  return RAW_MATERIAL_QR_PATTERN_V2.test(input) || RAW_MATERIAL_QR_PATTERN_V1.test(input);
}

export function parseRawMaterialQrId(rawInput: string): RawMaterialQrPayload {
  const input = rawInput.trim();

  const matchV2 = input.match(RAW_MATERIAL_QR_PATTERN_V2);
  if (matchV2) {
    const [, partyCode, itemCode, serial] = matchV2;
    return { qrId: input, partyCode, itemCode, serial };
  }

  const matchV1 = input.match(RAW_MATERIAL_QR_PATTERN_V1);
  if (matchV1) {
    const [, partyCode, itemCode, serial] = matchV1;
    return { qrId: input, partyCode, itemCode, serial };
  }

  throw new InvalidQrError("RAW_MATERIAL_QR_INVALID_FORMAT", "QR format is invalid for a raw material identity.");
}

// ─── Raw material packet lifecycle ────────────────────────────────────────────
// A raw material packet has no factory or gate stage: it arrives from a supplier, is
// received into the store, and is issued to the section that consumes it. These are the
// physical states a label can be in, and they are the raw-material counterpart of
// qr_master.current_status for finished cartons.

export const RAW_MATERIAL_QR_STATUS = {
  /** Printed and registered, not yet received into the store. */
  GENERATED: "GENERATED",
  /** Physically in the store, counted in this material's stock. */
  IN_STORE: "IN_STORE",
  /** Issued out of the store to a section (packing, upper maker, …). */
  ISSUED: "ISSUED",
} as const;

export type RawMaterialQrStatus = (typeof RAW_MATERIAL_QR_STATUS)[keyof typeof RAW_MATERIAL_QR_STATUS];

/** States a packet may be received into the store from: never scanned in, or sent back by a section. */
export const RAW_MATERIAL_STORE_ENTRY_ELIGIBLE: ReadonlySet<string> = new Set([
  RAW_MATERIAL_QR_STATUS.GENERATED,
  RAW_MATERIAL_QR_STATUS.ISSUED,
]);

/** Only a packet physically in the store can be issued out of it. */
export const RAW_MATERIAL_STORE_EXIT_ELIGIBLE: ReadonlySet<string> = new Set([RAW_MATERIAL_QR_STATUS.IN_STORE]);
