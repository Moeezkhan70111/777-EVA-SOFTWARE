export interface CanonicalQrPayload {
  qrId: string;
  article: string;
  color: string;
  size: string;
  serial: string;
  factoryCode?: string;
  batchCode?: string;
}

export class InvalidQrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "InvalidQrError";
  }
}

export interface QrParser {
  readonly version: string;
  canParse(rawInput: string): boolean;
  parse(rawInput: string): CanonicalQrPayload;
}

// V1 format: ARTICLE_COLOR_SIZE_SERIAL (example: SK6_BLUE_7/10_001)
const V1_PATTERN = /^([A-Z0-9]+)_([A-Z0-9]+)_([0-9]+\/[0-9]+)_([0-9]+)$/;

// V2 format: FACTORY_ARTICLE_COLOR_SIZE_BATCH_SERIAL
const V2_PATTERN = /^([A-Z0-9]+)_([A-Z0-9]+)_([A-Z0-9]+)_([0-9]+\/[0-9]+)_([A-Z0-9]+)_([0-9]+)$/;

export class QrParserV1 implements QrParser {
  readonly version = "v1";

  canParse(rawInput: string): boolean {
    return V1_PATTERN.test(rawInput.trim());
  }

  parse(rawInput: string): CanonicalQrPayload {
    const input = rawInput.trim();
    const match = input.match(V1_PATTERN);

    if (!match) {
      throw new InvalidQrError("QR_V1_INVALID_FORMAT", "QR format is invalid for V1.");
    }

    const [, article, color, size, serial] = match;
    return {
      qrId: input,
      article,
      color,
      size,
      serial,
    };
  }
}

export class QrParserV2 implements QrParser {
  readonly version = "v2";

  canParse(rawInput: string): boolean {
    return V2_PATTERN.test(rawInput.trim());
  }

  parse(rawInput: string): CanonicalQrPayload {
    const input = rawInput.trim();
    const match = input.match(V2_PATTERN);

    if (!match) {
      throw new InvalidQrError("QR_V2_INVALID_FORMAT", "QR format is invalid for V2.");
    }

    const [, factoryCode, article, color, size, batchCode, serial] = match;
    return {
      qrId: input,
      article,
      color,
      size,
      serial,
      factoryCode,
      batchCode,
    };
  }
}

export interface ParsedQrCode {
  parserVersion: string;
  payload: CanonicalQrPayload;
}

export class QrParserRegistry {
  constructor(private readonly parsers: QrParser[]) {}

  parse(rawInput: string): ParsedQrCode {
    const input = rawInput.trim();
    for (const parser of this.parsers) {
      if (parser.canParse(input)) {
        return {
          parserVersion: parser.version,
          payload: parser.parse(input),
        };
      }
    }

    throw new InvalidQrError(
      "QR_UNSUPPORTED_FORMAT",
      "QR format is invalid. Expected supported version format."
    );
  }
}

export function createDefaultQrParserRegistry(): QrParserRegistry {
  return new QrParserRegistry([new QrParserV1()]);
}

const defaultRegistry = createDefaultQrParserRegistry();

export function parseQrCode(rawInput: string): ParsedQrCode {
  return defaultRegistry.parse(rawInput);
}

export function isValidQrCode(rawInput: string): boolean {
  return V1_PATTERN.test(rawInput.trim());
}

// ─── Canonical identity construction (QR Generator) ──────────────────────────
// The QR Generator is the only writer of registered identities, so it builds them
// through these helpers. They are the exact inverse of QrParserV1 above: anything
// buildQrId returns is guaranteed to parse back to the same article/color/size.

/**
 * Minimum printed width of a serial. SIX, not seven, and that is load-bearing.
 *
 * Serials are allocated from a per-computer block a million wide (SERIAL_BLOCK_SIZE in
 * @erp/data's numberRange.ts): computer 1 owns 1-999,999, computer 2 owns 1,000,000-1,999,999,
 * and so on. padStart(6) is a NO-OP for anything from 1,000,000 up, so computer 1 keeps printing
 * the six-digit serials it always has and computers 2-5 come out seven digits naturally.
 *
 * DO NOT RAISE THIS TO 7. Padding everything to seven would make block 1's already-printed
 * `000500` and a freshly generated `0000500` two different identity STRINGS for serial 500, and
 * qr_codes.id / qr_master.qr_id are those strings. One number, two identities, is precisely the
 * ambiguity the block scheme exists to prevent.
 *
 * QrParserV1 reads the serial as `([0-9]+)`, so width never mattered to scanning.
 */
export const QR_SERIAL_WIDTH = 6;

/**
 * Upper bound for a single generation request — one realistic label print run.
 *
 * Here rather than in the data layer because the screens asking for a run have to refuse too
 * many BEFORE sending it, and the limit a screen checks must be the limit the registry enforces.
 */
export const MAX_QR_BATCH_QUANTITY = 10000;

/**
 * Where a run of carton QR identities came from (`qr_batches.source`, migration 077). Every run
 * is written by exactly one of these, and the Machine Program counts only QR_GENERATOR runs:
 *
 *   QR_GENERATOR     the QR Generator page — the cartons a program is made of
 *   B_CARTON         the B Carton Labels page (grade B, colour MIX)
 *   MACHINE_PROGRAM  labels printed by the retired machine-program workflow (Store Out, B conversions)
 *   SCAN_ADOPTED     an identity Live Production registered because it was printed outside the system
 */
export const QR_BATCH_SOURCE = {
  QR_GENERATOR: "QR_GENERATOR",
  B_CARTON: "B_CARTON",
  MACHINE_PROGRAM: "MACHINE_PROGRAM",
  SCAN_ADOPTED: "SCAN_ADOPTED",
} as const;
export type QrBatchSource = (typeof QR_BATCH_SOURCE)[keyof typeof QR_BATCH_SOURCE];

const QR_ARTICLE_PATTERN = /^[A-Z0-9]+$/;
const QR_COLOR_PATTERN = /^[A-Z0-9]+$/;
const QR_SIZE_PATTERN = /^[0-9]+\/[0-9]+$/;

/**
 * Folds every casing/spacing variant of a colour onto one logical identity, so
 * `red`, `Red`, ` RED ` and `Red ` all resolve to `RED`.
 */
export function normalizeQrColor(rawColor: string): string {
  return String(rawColor ?? "")
    .trim()
    .replace(/[\s_-]+/g, "")
    .toUpperCase();
}

export function normalizeQrArticle(rawArticle: string): string {
  return String(rawArticle ?? "").trim().toUpperCase();
}

export function normalizeQrSize(rawSize: string): string {
  return String(rawSize ?? "").trim().replace(/\s+/g, "");
}

export function formatQrSerial(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new InvalidQrError("QR_SERIAL_INVALID", "Serial must be a positive whole number.");
  }
  return String(sequence).padStart(QR_SERIAL_WIDTH, "0");
}

export interface QrIdentityParts {
  article: string;
  color: string;
  size: string;
  sequence: number;
}

/**
 * Builds the canonical `ARTICLE_COLOR_SIZE_SERIAL` identity. Throws InvalidQrError when
 * any part would produce a value the scanner could not parse — the generator must never
 * register an identity that cannot be scanned back.
 */
export function buildQrId(parts: QrIdentityParts): string {
  const article = normalizeQrArticle(parts.article);
  const color = normalizeQrColor(parts.color);
  const size = normalizeQrSize(parts.size);

  if (!QR_ARTICLE_PATTERN.test(article)) {
    throw new InvalidQrError(
      "QR_ARTICLE_INVALID",
      `Article "${parts.article}" cannot be encoded. Use letters and digits only (no spaces, slashes or underscores).`
    );
  }
  if (!QR_COLOR_PATTERN.test(color)) {
    throw new InvalidQrError(
      "QR_COLOR_INVALID",
      `Colour "${parts.color}" cannot be encoded. Use letters and digits only (no slashes or punctuation).`
    );
  }
  if (!QR_SIZE_PATTERN.test(size)) {
    throw new InvalidQrError(
      "QR_SIZE_INVALID",
      `Size "${parts.size}" cannot be encoded. Expected a number/number value such as 7/10.`
    );
  }

  return `${article}_${color}_${size}_${formatQrSerial(parts.sequence)}`;
}
