// RESERVED DOCUMENT-NUMBER RANGES — one block of numbers per computer.
//
//   computer 1   1 - 99,999        computer 4   300,000 - 399,999
//   computer 2   100,000 - 199,999 computer 5   400,000 - 499,999
//   computer 3   200,000 - 299,999 500,000+     reserved for future machines
//
// WHY. Every generated document number in this ERP is allocated as MAX(...) + 1 against the
// LOCAL SQLite file, inside BEGIN IMMEDIATE. That is correct for two windows on one computer and
// wrong for two computers: both compute the same "next" while offline, and the UNIQUE constraint
// then refuses one of them at save time — after the operator has done the work. Giving each
// computer its own block makes the numbers disjoint by construction, with no coordination and no
// network, which is what keeps offline creation possible.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//
//   * It never renumbers anything. Existing documents keep their numbers exactly.
//   * It never changes a visible format. GP-000001 stays GP-000001 — only the magnitude of
//     newly allocated numbers differs on computers 2-5.
//   * It never backfills a gap or reuses a deleted number. SCR- already has gaps, and reusing
//     one would alias a document somebody may still hold on paper.
//   * It never falls back to a global MAX + 1. An unconfigured computer refuses to allocate.
//   * It does not touch QR serials. Carton and raw-material QR identities are allocated from
//     their own counter tables and are NOT covered here — see the note at the foot of this file.
//
// LIMIT, STATED PLAINLY: nothing in this file can stop two computers being given the SAME block.
// Until a shared database exists there is no central authority to ask. The protections are the
// written assignment the operator keeps, the out-of-range check below, and the UNIQUE constraints
// that turn a collision into a refused save rather than two documents with one number.

import type { SqliteDatabase } from "../sqliteDatabase.js";

/** Settings key holding this computer's block number. Absent means "not configured". */
export const NUMBER_BLOCK_SETTING_KEY = "numbering.block";
/** Settings key recording that an administrator confirmed the block for THIS computer. */
export const NUMBER_BLOCK_CONFIRMED_KEY = "numbering.block.confirmed";

export const NUMBER_BLOCK_SIZE = 100_000;

/**
 * Block size for QR SERIALS, which is ten times the document-number block.
 *
 *   computer 1   1 - 999,999          computer 4   3,000,000 - 3,999,999
 *   computer 2   1,000,000 - 1,999,999 computer 5  4,000,000 - 4,999,999
 *   computer 3   2,000,000 - 2,999,999 5,000,000+  reserved for future machines
 *
 * WHY ITS OWN SIZE. Serials are counted per article+colour+size, so the question is not "how
 * many documents will this company ever write" but "how many cartons of ONE article in ONE
 * colour in ONE size will ONE computer ever label". A million each is headroom nobody has to
 * think about again; the highest serial in use when this was written was 113.
 *
 * WHY THE FORMAT DOES NOT CHANGE. `formatQrSerial` pads to six digits, which is a no-op for any
 * value of 1,000,000 or more. So block 1 keeps printing six-digit serials exactly as it always
 * has, blocks 2-5 come out seven digits naturally, and — the part that matters — no two serial
 * STRINGS can ever denote the same number. Padding everything to seven would have made block
 * 1's existing `000500` and a new `0000500` two different identities for serial 500.
 */
export const SERIAL_BLOCK_SIZE = 1_000_000;
/** Blocks 1-5 are assignable today. 6+ (500,000 and above) is reserved for future machines. */
export const MAX_ASSIGNABLE_BLOCK = 5;

/**
 * The only block a computer can work out for itself: the installation that already holds the
 * company's numbered documents. Every other block is a factory-wide decision that this computer
 * has no way to verify — see adoptExistingDataNumberBlock.
 */
export const EXISTING_DATA_BLOCK = 1;

/**
 * The settings keys that decide which numbers this computer owns. They are written ONLY by
 * provisioning. The desktop's generic "save settings" path drops them, so an operator editing a
 * settings field cannot change this computer's block and start colliding with another machine.
 */
export const PROTECTED_NUMBER_SETTING_KEYS: readonly string[] = [
  NUMBER_BLOCK_SETTING_KEY,
  NUMBER_BLOCK_CONFIRMED_KEY,
];

export interface NumberRange {
  block: number;
  /** First number this computer may allocate. */
  lo: number;
  /** Last number this computer may allocate. */
  hi: number;
}

/**
 * The bounds of a block. Block 1 starts at 1 rather than 0 because 0 is not a document number;
 * every later block starts on its round hundred-thousand, as the assignment table above reads.
 */
export function rangeForBlock(block: number): NumberRange {
  const base = (block - 1) * NUMBER_BLOCK_SIZE;
  return { block, lo: block === 1 ? 1 : base, hi: base + NUMBER_BLOCK_SIZE - 1 };
}

/**
 * The QR-serial bounds of a block. Same shape as rangeForBlock, at SERIAL_BLOCK_SIZE.
 *
 * Block 1 starts at 1 rather than 0 for the same reason documents do — 0 is not a serial — and
 * because every serial 777 has ever printed lives in block 1 and must stay exactly as printed.
 */
export function serialRangeForBlock(block: number): NumberRange {
  const base = (block - 1) * SERIAL_BLOCK_SIZE;
  return { block, lo: block === 1 ? 1 : base, hi: base + SERIAL_BLOCK_SIZE - 1 };
}

/** A block number this computer could legitimately be assigned. */
/**
 * Every range a second computer may be given: blocks EXISTING_DATA_BLOCK+1 .. MAX_ASSIGNABLE_BLOCK.
 * One list, derived from rangeForBlock, so the Settings panel shows exactly the numbers the
 * assignment would record.
 */
export function assignableRanges(): NumberRange[] {
  const blocks: NumberRange[] = [];
  for (let block = EXISTING_DATA_BLOCK + 1; block <= MAX_ASSIGNABLE_BLOCK; block += 1) {
    blocks.push(rangeForBlock(block));
  }
  return blocks;
}

export function isAssignableBlock(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_ASSIGNABLE_BLOCK;
}

// ─── The audited allocation sites ───────────────────────────────────────────
//
// Table and column names come from THIS table and nowhere else. Nothing a caller supplies is
// ever interpolated into SQL — a caller passes a key of NUMBER_SITES, and values are bound.

/** How the stored value turns into the number the series counts in. */
export type NumberParse =
  /** The column is already the integer, e.g. gatepasses.gatepass_number. */
  | { readonly kind: "INT" }
  /** The column is a prefixed code, e.g. PTY-000001: the digits start at 1-based `from`. */
  | { readonly kind: "SUFFIX"; readonly from: number };

export interface NumberSite {
  readonly table: string;
  readonly column: string;
  readonly parse: NumberParse;
  /** Extra SQL restricting the series, e.g. only codes with this prefix. Fixed text, never input. */
  readonly where?: string;
  /** Human name used in operator-facing errors. */
  readonly noun: string;
  /**
   * True when the number normally comes from outside the ERP (a paper bill book, a supplier's
   * invoice). The range then applies ONLY to the automatic fallback, and the out-of-range guard
   * is skipped — a typed number may legitimately be any value at all.
   */
  readonly external?: boolean;
}

export const NUMBER_SITES = {
  cashVoucher: { table: "cash_vouchers", column: "voucher_number", parse: { kind: "INT" }, noun: "cash voucher numbers" },
  saleVoucher: { table: "sale_vouchers", column: "voucher_number", parse: { kind: "INT" }, noun: "sale voucher numbers", external: true },
  purchaseVoucher: { table: "purchase_vouchers", column: "voucher_number", parse: { kind: "INT" }, noun: "purchase voucher numbers", external: true },
  gatepass: { table: "gatepasses", column: "gatepass_number", parse: { kind: "INT" }, noun: "gatepass numbers" },
  machineProgram: { table: "machine_programs", column: "program_number", parse: { kind: "INT" }, noun: "machine program numbers" },
  manualProduction: { table: "manual_production_entries", column: "entry_number", parse: { kind: "INT" }, noun: "manual production numbers" },
  partyCode: { table: "parties", column: "party_code", parse: { kind: "SUFFIX", from: 5 }, noun: "party codes" },
  productCode: { table: "article_sizes", column: "product_code", parse: { kind: "SUFFIX", from: 5 }, where: "product_code IS NOT NULL", noun: "product codes" },
  rmReceivingSession: { table: "raw_material_receiving_sessions", column: "session_number", parse: { kind: "INT" }, noun: "raw material receiving numbers" },
  rmIssueSession: { table: "raw_material_issue_sessions", column: "session_number", parse: { kind: "INT" }, noun: "raw material issue numbers" },
  storeReceivingSession: { table: "store_receiving_sessions", column: "session_number", parse: { kind: "INT" }, noun: "store receiving numbers" },
  storeMoveOutSession: { table: "store_move_out_sessions", column: "session_number", parse: { kind: "INT" }, noun: "store move out numbers" },
  partyClaim: { table: "party_claims", column: "claim_number", parse: { kind: "SUFFIX", from: 4 }, noun: "claim numbers" },
  removalRequest: { table: "removal_requests", column: "request_code", parse: { kind: "SUFFIX", from: 5 }, where: "request_code LIKE 'DEL-%'", noun: "removal request numbers" },
  stockCorrection: { table: "stock_correction_requests", column: "request_code", parse: { kind: "SUFFIX", from: 5 }, where: "request_code LIKE 'SCR-%'", noun: "stock correction numbers" },
  machineCode: { table: "machines", column: "machine_code", parse: { kind: "SUFFIX", from: 3 }, where: "machine_code LIKE 'M-%'", noun: "machine codes" },
  inventoryItemCode: { table: "inventory_items", column: "item_code", parse: { kind: "SUFFIX", from: 4 }, where: "item_code LIKE 'RM-%'", noun: "raw material codes" },
  workSectionCode: { table: "work_sections", column: "section_code", parse: { kind: "SUFFIX", from: 4 }, where: "section_code LIKE 'WS-%'", noun: "work section codes" },
} as const satisfies Record<string, NumberSite>;

export type NumberSiteKey = keyof typeof NUMBER_SITES;

/** The SQL expression that reads the series number out of the column, for one audited site. */
function numberExpression(site: NumberSite): string {
  return site.parse.kind === "INT"
    ? `CAST(COALESCE(NULLIF(TRIM(CAST(${site.column} AS TEXT)), ''), '0') AS INTEGER)`
    : `CAST(SUBSTR(${site.column}, ${site.parse.from}) AS INTEGER)`;
}

// ─── Errors the operator sees ───────────────────────────────────────────────

export class NumberRangeError extends Error {
  constructor(
    readonly reason:
      | "NOT_CONFIGURED"
      | "INVALID"
      | "OUT_OF_RANGE"
      | "EXHAUSTED"
      /** A block is already recorded on this computer. Provisioning never overwrites one. */
      | "ALREADY_CONFIGURED"
      /** A fresh installation: there is no existing series to work a block out from. */
      | "NO_EXISTING_DATA",
    message: string
  ) {
    super(message);
    this.name = "NumberRangeError";
  }
}

const NOT_CONFIGURED_MESSAGE =
  "This computer has not been given its document-number range. An administrator must set it in Settings before documents can be created here. Scanning and every other kind of work are unaffected.";

const SERIAL_NOT_CONFIGURED_MESSAGE =
  "This computer has not been given its number range, so it cannot print QR labels — two computers without ranges would print the same serials. An administrator must set it in Settings. Scanning, production, dispatch and store work are unaffected.";

// ─── Reading and validating the configured block ────────────────────────────

/** One setting as stored text, or null when it is absent or blank. */
function readSetting(db: SqliteDatabase, key: string): string | null {
  const row = db.db
    .prepare("SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1")
    .get(key) as { setting_value?: string } | undefined;
  if (!row || row.setting_value == null) return null;
  const text = String(row.setting_value).trim();
  return text === "" ? null : text;
}

/** The raw stored value, or null when this computer has never been configured. */
export function readNumberBlock(db: SqliteDatabase): number | null {
  const text = readSetting(db, NUMBER_BLOCK_SETTING_KEY);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** True once a block was recorded through provisioning on THIS computer. */
export function readNumberBlockConfirmed(db: SqliteDatabase): boolean {
  return readSetting(db, NUMBER_BLOCK_CONFIRMED_KEY) === "1";
}

/**
 * This computer's range, or a refusal. Never guesses: an absent setting is "not configured",
 * and anything that is not an assignable block is a hard error rather than a silent default.
 */
export function requireNumberRange(db: SqliteDatabase): NumberRange {
  const block = readNumberBlock(db);
  if (block === null) throw new NumberRangeError("NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE);
  if (!isAssignableBlock(block)) {
    throw new NumberRangeError(
      "INVALID",
      `The document-number range on this computer is not valid (found "${block}"). It must be a whole number from 1 to ${MAX_ASSIGNABLE_BLOCK}. Documents cannot be created until an administrator corrects it.`
    );
  }
  return rangeForBlock(block);
}

/**
 * This computer's QR-SERIAL range, or a refusal.
 *
 * BEHAVIOUR CHANGE, STATED PLAINLY: until this existed, label generation worked on a computer
 * with no block assigned. It no longer does. A computer that does not know which block it owns
 * cannot know which serials are safe to print, and two computers printing the same serial is two
 * physical cartons the system cannot tell apart — the one failure the whole scheme exists to
 * prevent. So it refuses, exactly as a numbered document already does.
 *
 * Scanning, production, dispatch, returns and store movements are unaffected, as they are for
 * documents. Only the PRINTING of new labels needs the block.
 */
export function requireSerialRange(db: SqliteDatabase): NumberRange {
  const block = readNumberBlock(db);
  if (block === null) throw new NumberRangeError("NOT_CONFIGURED", SERIAL_NOT_CONFIGURED_MESSAGE);
  if (!isAssignableBlock(block)) {
    throw new NumberRangeError(
      "INVALID",
      `The document-number range on this computer is not valid (found "${block}"). It must be a whole number from 1 to ${MAX_ASSIGNABLE_BLOCK}. QR labels cannot be generated until an administrator corrects it.`
    );
  }
  return serialRangeForBlock(block);
}

/**
 * This computer's serial range, or null when it has none — the non-throwing form.
 *
 * For callers that must not FAIL over a missing block, only behave differently. Adoption is the
 * one: taking in a real carton that somebody scanned must never be refused because this computer
 * has not been provisioned for printing.
 */
export function readSerialRangeIfConfigured(db: SqliteDatabase): NumberRange | null {
  const block = readNumberBlock(db);
  if (block === null || !isAssignableBlock(block)) return null;
  return serialRangeForBlock(block);
}

/**
 * Reserves `quantity` serials for one counter and returns the range handed out, or refuses.
 *
 * `currentLastSequence` is what the counter holds now, or null when the counter does not exist
 * yet — a brand-new article/colour/size on this computer, which starts at the FLOOR OF ITS OWN
 * BLOCK rather than at zero.
 *
 * CALL THIS INSIDE THE WRITE TRANSACTION. The value is only safe while the write lock is held,
 * exactly as allocateNumberInRange is.
 *
 * REFUSES THE WHOLE RUN when it would not fit. Partially filling a request for 100 labels with
 * 49 is worse than refusing: the operator asked for a number of stickers, and a short run that
 * nobody noticed is a physical count that stops matching the system.
 */
export function reserveSerialRange(
  range: NumberRange,
  currentLastSequence: number | null,
  quantity: number,
  noun: string
): { startSequence: number; endSequence: number } {
  const current = currentLastSequence === null ? range.lo - 1 : currentLastSequence;
  const startSequence = current + 1;
  const endSequence = current + quantity;

  if (endSequence > range.hi) {
    const remaining = Math.max(0, range.hi - current);
    throw new NumberRangeError(
      "EXHAUSTED",
      `The ${noun} for this computer are used up (range ${range.lo}-${range.hi}). ` +
        `${String(remaining)} remain and ${String(quantity)} were asked for. Nothing has been saved. ` +
        `Ask an administrator for a new range.`
    );
  }

  return { startSequence, endSequence };
}

/**
 * Whether an externally chosen serial belongs to this computer's own block.
 *
 * Used by adoption. A carton label printed outside the system carries whatever serial it
 * carries, and the counter must only be pushed forward by one that this computer could itself
 * have issued. A serial from another computer's block is still REGISTERED — refusing to take in
 * a real carton would be worse — but it must not drag this computer's counter into that block,
 * because the next generated serial would then collide with the computer that owns it.
 */
export function isWithinSerialRange(range: NumberRange, sequence: number): boolean {
  return Number.isInteger(sequence) && sequence >= range.lo && sequence <= range.hi;
}

// ─── Counting what is already there ─────────────────────────────────────────

/**
 * Numbers at one site that the given range could not have produced, and the highest of them.
 *
 * A computer whose existing documents sit outside its block was almost certainly given the wrong
 * block, so both allocation and provisioning refuse on the strength of this.
 */
function countOutsideRange(
  db: SqliteDatabase,
  site: NumberSite,
  range: NumberRange
): { count: number; highest: number | null } {
  const expression = numberExpression(site);
  const filter = site.where ? ` AND ${site.where}` : "";
  const row = db.db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(${expression}) AS mx FROM ${site.table}
        WHERE (${expression} < ? OR ${expression} > ?)${filter}`
    )
    .get(range.lo, range.hi) as { n: number; mx: number | null };
  return { count: Number(row.n), highest: row.mx === null ? null : Number(row.mx) };
}

/** How many numbers at one site already belong to the given range. */
function countInsideRange(db: SqliteDatabase, site: NumberSite, range: NumberRange): number {
  const expression = numberExpression(site);
  const filter = site.where ? ` AND ${site.where}` : "";
  const row = db.db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${site.table}
        WHERE ${expression} BETWEEN ? AND ?${filter}`
    )
    .get(range.lo, range.hi) as { n: number };
  return Number(row.n);
}

// ─── Allocation ─────────────────────────────────────────────────────────────

/**
 * The next number for one site, inside this computer's block.
 *
 * Call this INSIDE the write transaction that inserts the row — the value is only safe for as
 * long as the write lock is held. It counts forward from the highest number already used IN THIS
 * BLOCK, so gaps stay gaps and a deleted number is never handed out again.
 *
 * Refuses, rather than inventing a number, when the computer is unconfigured, when its data does
 * not belong to the configured block, or when the block is used up.
 */
export function allocateNumberInRange(db: SqliteDatabase, key: NumberSiteKey): number {
  const site: NumberSite = NUMBER_SITES[key];
  const range = requireNumberRange(db);
  const expression = numberExpression(site);
  const filter = site.where ? ` AND ${site.where}` : "";

  // A computer whose existing documents sit outside its block was almost certainly given the
  // wrong block. Allocating anyway would interleave two computers' series, so refuse and say so.
  // Skipped for externally numbered documents, where a typed number may be any value at all.
  if (!site.external) {
    const stray = countOutsideRange(db, site, range);
    if (stray.count > 0) {
      throw new NumberRangeError(
        "OUT_OF_RANGE",
        `This computer's ${site.noun} include values outside its assigned range ${range.lo}-${range.hi} (highest found: ${stray.highest}). This usually means the wrong range was assigned. Nothing has been changed — ask an administrator to resolve it before creating documents.`
      );
    }
  }

  const row = db.db
    .prepare(
      `SELECT COALESCE(MAX(${expression}), ?) + 1 AS n FROM ${site.table}
        WHERE ${expression} BETWEEN ? AND ?${filter}`
    )
    .get(range.lo - 1, range.lo, range.hi) as { n: number };

  const next = Number(row.n);
  if (next > range.hi) {
    throw new NumberRangeError(
      "EXHAUSTED",
      `The ${site.noun} for this computer are used up (range ${range.lo}-${range.hi}). Nothing has been saved. Ask an administrator for a new range.`
    );
  }
  return next;
}

// ─── Provisioning ───────────────────────────────────────────────────────────
//
// There is no provisioning authority yet: no server issues blocks, and nothing here can tell
// whether another computer in the factory already holds a given block. So this file assigns a
// block in exactly ONE case, the case it can prove from the data in front of it:
//
//   the installation that ALREADY holds the company's numbered documents is block 1.
//
// That is not a choice — it is the only block those documents could belong to, and getting it
// wrong is detectable (every existing number would be out of range). The administrator confirms
// it; they do not pick it, and there is deliberately no way to type a block number.
//
// A computer with NO numbered documents is a new installation. Which block it should hold is a
// factory-wide decision, and nothing on the machine can verify that the answer it is given is
// not already in use somewhere else. Those computers are refused here, and must wait for the
// provisioning authority the deployment plan calls for.

/** Why this computer may not record a block for itself. */
export type AdoptRefusal =
  /** A block is already recorded here. */
  | "ALREADY_CONFIGURED"
  /** No numbered documents exist, so no block can be derived. */
  | "NO_EXISTING_DATA"
  /** Numbered documents exist, but block 1 could not have produced them. */
  | "OUT_OF_RANGE";

export interface AdoptionCheck {
  /** True when this computer may record block `EXISTING_DATA_BLOCK` for itself. */
  readonly allowed: boolean;
  readonly refusal: AdoptRefusal | null;
  /** What the administrator is told. Empty when allowed. */
  readonly detail: string;
}

/** What the Settings status view is allowed to know. Read-only, and holds nothing secret. */
export interface NumberBlockStatus {
  /** The assignable block this computer holds, or null when it holds none. */
  readonly block: number | null;
  /** The numbers this computer may allocate, or null when it holds no usable block. */
  readonly range: NumberRange | null;
  /** True once a block was recorded here through provisioning. */
  readonly confirmed: boolean;
  /** Why documents cannot be created here, or null when the configuration is usable. */
  readonly problem: "NOT_CONFIGURED" | "INVALID" | null;
  /** What is actually stored, when it is not an assignable block, so it can be corrected. */
  readonly storedValue: string | null;
  readonly adoption: AdoptionCheck;
  /**
   * The ranges a SECOND computer may be given, in order, for an administrator to pick from
   * against the factory's own written record of which machine holds which.
   *
   * Carried here so no screen works a range out for itself: the arithmetic that turns a block
   * into its numbers lives in rangeForBlock and nowhere else. Block 1 is never among them --
   * it belongs to the installation that holds the existing documents, which adopts it instead.
   * Empty once a range is recorded here, because a range is never reassigned.
   */
  readonly assignable: readonly NumberRange[];
}

const allowedAdoption: AdoptionCheck = { allowed: true, refusal: null, detail: "" };

const refuseAdoption = (refusal: AdoptRefusal, detail: string): AdoptionCheck => ({
  allowed: false,
  refusal,
  detail,
});

/**
 * Whether this computer may record `EXISTING_DATA_BLOCK` for itself, and why not when it may not.
 *
 * Reads only. Walks every audited site, skipping the externally numbered ones: a sale or purchase
 * voucher number typed from a paper book may legitimately be any value, so it neither proves nor
 * disproves which block this computer is.
 */
export function checkExistingDataAdoption(db: SqliteDatabase): AdoptionCheck {
  if (readNumberBlock(db) !== null || readNumberBlockConfirmed(db)) {
    return refuseAdoption(
      "ALREADY_CONFIGURED",
      "This computer already has a document-number range recorded. A range is never reassigned here — changing it would let two computers hand out the same numbers."
    );
  }

  const range = rangeForBlock(EXISTING_DATA_BLOCK);
  const outside: string[] = [];
  let inside = 0;

  for (const key of Object.keys(NUMBER_SITES) as NumberSiteKey[]) {
    const site: NumberSite = NUMBER_SITES[key];
    if (site.external) continue;
    const stray = countOutsideRange(db, site, range);
    if (stray.count > 0) outside.push(`${site.noun} (highest ${stray.highest})`);
    inside += countInsideRange(db, site, range);
  }

  if (outside.length > 0) {
    return refuseAdoption(
      "OUT_OF_RANGE",
      `This computer's existing documents do not all fit range ${range.lo}-${range.hi}: ${outside.join(", ")}. Nothing has been changed. This has to be looked at before a range is recorded.`
    );
  }

  if (inside === 0) {
    return refuseAdoption(
      "NO_EXISTING_DATA",
      "This is a new installation with no numbered documents, so it cannot work out which range it should hold. The range has to be assigned deliberately below, from the factory's record of which computer holds which range."
    );
  }

  return allowedAdoption;
}

// ─── Methods merged onto SqliteDatabase ─────────────────────────────────────

export const numberRangeMethods = {
  /** This computer's block, or null when it has never been configured. */
  getNumberBlock(this: SqliteDatabase): number | null {
    const block = readNumberBlock(this);
    return block !== null && isAssignableBlock(block) ? block : null;
  },

  /** This computer's range, or a NumberRangeError explaining why there is none. */
  requireNumberRange(this: SqliteDatabase): NumberRange {
    return requireNumberRange(this);
  },

  /**
   * Records the block an administrator chose for THIS computer, and marks it confirmed.
   *
   * Deliberately explicit: nothing infers a block from the hostname, the device id or anything
   * else about the machine. Restoring this database onto different hardware carries the block
   * with it, which is a reassignment to make deliberately — see the note in this file's header.
   */
  setNumberBlock(this: SqliteDatabase, block: number, updatedBy = "admin"): NumberRange {
    if (!isAssignableBlock(block)) {
      throw new NumberRangeError(
        "INVALID",
        `A document-number range must be a whole number from 1 to ${MAX_ASSIGNABLE_BLOCK}.`
      );
    }
    this.setSettings(
      { [NUMBER_BLOCK_SETTING_KEY]: String(block), [NUMBER_BLOCK_CONFIRMED_KEY]: "1" },
      updatedBy
    );
    return rangeForBlock(block);
  },

  /**
   * Records a block an administrator has been told to give a SECOND computer, from the factory's
   * own record of which machine holds which range.
   *
   * WHY THIS EXISTS BESIDE adoptExistingDataNumberBlock. That one is the single block a computer
   * can work out for itself: the installation already holding the company's numbered documents is
   * block 1, and the check proves it from the data. Every other block is a factory-wide decision
   * this computer has no way to verify, which is why there was no way to provision a second
   * computer at all -- it could create no numbered document of any kind.
   *
   * WHAT THIS CANNOT CHECK, AND NEVER WILL FROM HERE. It cannot tell whether the range it is
   * handed has already been given to another computer. There is no shared authority to ask: each
   * installation holds only its own SQLite file, which is the whole reason the ranges exist. So
   * the caller's written record is the authority, and this function refuses only the two things
   * it CAN prove wrong -- block 1, and a range already recorded here. A duplicate assignment
   * across two machines surfaces later, as a refused save on a UNIQUE constraint, not as an
   * error here. See the LIMIT note in this file's header.
   *
   * BLOCK 1 IS NOT ASSIGNABLE HERE, deliberately. It belongs to whichever installation carries the
   * existing documents, and handing it to a second computer is precisely the collision the whole
   * scheme exists to prevent. A computer that IS the existing-data machine adopts it through
   * adoptExistingDataNumberBlock, which proves the claim before recording it.
   *
   * A RANGE IS NEVER REASSIGNED, the same rule adoptExistingDataNumberBlock enforces: a recorded
   * block is refused rather than overwritten, because changing it would let two computers hand out
   * the same numbers for documents that already exist.
   */
  assignNumberBlock(this: SqliteDatabase, block: number, updatedBy: string): NumberRange {
    if (block === EXISTING_DATA_BLOCK) {
      throw new NumberRangeError(
        "INVALID",
        `Range ${EXISTING_DATA_BLOCK} belongs to the computer that already holds the company's numbered documents. ` +
          "That computer records it itself from its own data. Give this computer one of the others."
      );
    }
    if (!isAssignableBlock(block)) {
      throw new NumberRangeError(
        "INVALID",
        `A document-number range must be a whole number from ${EXISTING_DATA_BLOCK + 1} to ${MAX_ASSIGNABLE_BLOCK} for a second computer.`
      );
    }

    const recorded = readNumberBlock(this);
    if (recorded !== null || readNumberBlockConfirmed(this)) {
      throw new NumberRangeError(
        "ALREADY_CONFIGURED",
        "This computer already has a document-number range recorded. A range is never reassigned here — " +
          "changing it would let two computers hand out the same numbers."
      );
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      // Re-read under the write lock: another window could have provisioned in between.
      if (readNumberBlock(this) !== null || readNumberBlockConfirmed(this)) {
        throw new NumberRangeError(
          "ALREADY_CONFIGURED",
          "This computer was given a document-number range while this one was being recorded. Nothing has been changed."
        );
      }
      // Anything already numbered here must fit the block being recorded, or this computer has
      // documents it could not have issued and the assignment is wrong. Same guard as adoption,
      // against the chosen range rather than block 1.
      const range = rangeForBlock(block);
      const outside: string[] = [];
      for (const key of Object.keys(NUMBER_SITES) as NumberSiteKey[]) {
        const site: NumberSite = NUMBER_SITES[key];
        if (site.external) continue;
        const stray = countOutsideRange(this, site, range);
        if (stray.count > 0) outside.push(`${site.noun} (highest ${String(stray.highest)})`);
      }
      if (outside.length > 0) {
        throw new NumberRangeError(
          "OUT_OF_RANGE",
          `This computer's existing documents do not all fit range ${String(range.lo)}-${String(range.hi)}: ${outside.join(", ")}. ` +
            "Nothing has been changed. This has to be looked at before a range is recorded."
        );
      }

      this.setSettings(
        { [NUMBER_BLOCK_SETTING_KEY]: String(block), [NUMBER_BLOCK_CONFIRMED_KEY]: "1" },
        updatedBy
      );
      this.db.exec("COMMIT");
      return range;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  },

  /** True once an administrator has confirmed this computer's block for this machine. */
  isNumberBlockConfirmed(this: SqliteDatabase): boolean {
    return readNumberBlockConfirmed(this);
  },

  /**
   * Everything the Settings status view shows. Reads only — never records or corrects anything.
   */
  getNumberBlockStatus(this: SqliteDatabase): NumberBlockStatus {
    const stored = readNumberBlock(this);
    const confirmed = readNumberBlockConfirmed(this);
    const usable = stored !== null && isAssignableBlock(stored);
    return {
      block: usable ? stored : null,
      range: usable ? rangeForBlock(stored) : null,
      confirmed,
      problem: stored === null ? "NOT_CONFIGURED" : usable ? null : "INVALID",
      storedValue: usable ? null : readSetting(this, NUMBER_BLOCK_SETTING_KEY),
      adoption: checkExistingDataAdoption(this),
      // Offered only while nothing is recorded here. A stored block -- even an invalid one --
      // is corrected by an administrator at the database, not reassigned from the application.
      assignable: stored === null ? assignableRanges() : [],
    };
  },

  /**
   * Records `EXISTING_DATA_BLOCK` for the installation that already holds the company's numbered
   * documents, after proving that is what this computer is.
   *
   * Takes no block number on purpose: there is nothing to choose. Refuses outright if a block is
   * already recorded here — a mis-assigned block has no in-application correction, and inventing
   * one would be the reassignment that lets two computers share a series.
   *
   * Both settings are written in one transaction so a half-finished write cannot leave a block
   * active that was never confirmed. Never call this inside another transaction.
   */
  adoptExistingDataNumberBlock(this: SqliteDatabase, updatedBy: string): NumberRange {
    const check = checkExistingDataAdoption(this);
    if (!check.allowed) {
      const reason = check.refusal ?? "NO_EXISTING_DATA";
      throw new NumberRangeError(reason, check.detail);
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      // Re-check under the write lock: another window could have provisioned in between.
      const again = checkExistingDataAdoption(this);
      if (!again.allowed) {
        throw new NumberRangeError(again.refusal ?? "ALREADY_CONFIGURED", again.detail);
      }
      this.setSettings(
        { [NUMBER_BLOCK_SETTING_KEY]: String(EXISTING_DATA_BLOCK), [NUMBER_BLOCK_CONFIRMED_KEY]: "1" },
        updatedBy
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return rangeForBlock(EXISTING_DATA_BLOCK);
  },

  /**
   * Writes settings on behalf of an operator, refusing the keys that decide this computer's
   * document-number range whatever the caller sends, and reporting which it dropped.
   *
   * The Settings screen reads every setting and sends the whole map back when it saves, so the
   * range has to be filtered out rather than trusted not to appear: an operator editing a
   * settings field must not be able to point this computer at another machine's numbers. The
   * range is written only by provisioning, above.
   */
  setOperatorSettings(
    this: SqliteDatabase,
    entries: Record<string, string>,
    updatedBy: string
  ): { dropped: string[] } {
    const allowed: Record<string, string> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(entries)) {
      if (PROTECTED_NUMBER_SETTING_KEYS.includes(key)) dropped.push(key);
      else allowed[key] = value;
    }
    this.setSettings(allowed, updatedBy);
    return { dropped };
  },

  /** @internal The next number for an audited site. Call inside the write transaction. */
  allocateNumberInRange(this: SqliteDatabase, key: NumberSiteKey): number {
    return allocateNumberInRange(this, key);
  },
};

export type NumberRangeMethods = typeof numberRangeMethods;

// ─── QR SERIALS ARE COVERED TOO (2026-10-22) ────────────────────────────────
//
// Carton QR identities (qr_sequences, keyed by article/colour/size) and raw-material QR
// identities (raw_material_qr_sequences, keyed by party/item) use the SAME per-computer block
// scheme, at SERIAL_BLOCK_SIZE. Every computer can print labels; none can print another's
// serials. See requireSerialRange / reserveSerialRange above.
//
// This replaces an earlier note here that said QR generation had to stay on one designated
// workstation until a scheme was designed. It is designed, and this is it.
//
// The three things that note warned would defeat a naive per-computer scheme, and what each
// turned out to need:
//
//   COUNTER SEEDING — a counter for a combination this computer has not printed before used to
//     start at 0. It now starts at the floor of this computer's own block
//     (reserveSerialRange's `currentLastSequence === null` case). Migration 021's one-time
//     historical seed is untouched: it produced the correct values on block 1, and a fresh
//     computer has no history for it to read.
//
//   RESTORED BACKUPS — still a real hazard, and NOT solved here. Restoring a backup rolls the
//     counter back, and the serials between then and now get issued a second time. The block
//     scheme does not change that in either direction; it is the same risk as before, now
//     confined to one computer's own block. Re-seeding a counter from what the cloud already
//     knows is a later phase.
//
//   SCAN_ADOPTED — a label printed outside the system carries a serial nobody here chose.
//     Adoption now advances the counter only when that serial falls in THIS computer's block
//     (isWithinSerialRange); outside it the carton is still registered, but the counter is left
//     alone. Measured 2026-10-22 against the verified backup: all 64 adopted serials lie between
//     1 and 64, so every one of them is in block 1 and blocks 2-5 are unexposed.
