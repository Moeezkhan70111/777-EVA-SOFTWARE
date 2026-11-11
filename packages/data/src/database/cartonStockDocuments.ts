// STOCK ADJUSTMENT DOCUMENTS (docs/46): Opening Stock and Stock Adjustment, posted on the carton computer.
//
//   WRITE  postCartonStockAdjustment   SA-000001 · OPENING · SK6 RED 7/10 +20, 10/13 +35
//   READ   cartonAdjustmentArticle     one article's colours and sizes, each with its figure and whether it has opening
//   READ   listCartonStockAdjustments  the documents, newest first, a page at a time, each with its lines
//
// One document, in ONE BEGIN IMMEDIATE transaction, all or nothing:
//   1. the document under the next number in this computer's range (carton_stock_adjustments)
//   2. per line, one CARTON_ADJUST_IN or CARTON_ADJUST_OUT movement (cartonStock.ts), which moves the figure and
//      travels like every other carton movement, and the line naming that movement
// A line that would take the figure below zero, a second opening for a product, or any bad line refuses the whole
// document, and nothing is written. The capture triggers mark the document for the carton lease; the movements are
// marked by their own trigger. Manual Production is not touched.
//
// The screen's request id is the document's id: a Post retried after an answer that never arrived finds the document
// it already made and adds nothing.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import {
  CARTON_ADJUSTMENT_DIRECTION,
  CARTON_ADJUSTMENT_KIND,
  CARTON_ADJUSTMENT_MAX_LINES,
  CARTON_STOCK_EVENT_TYPE,
  cartonAdjustmentQuantityProblem,
  formatCartonAdjustmentCode,
  isBusinessDate,
  isCartonAdjustmentDirection,
  isCartonAdjustmentKind,
  type CartonAdjustmentDirection,
  type CartonAdjustmentKind,
} from "@erp/domain";
import { allocateNumberInRange } from "./numberRange.js";
import { CartonStockWouldGoNegative, recordCartonStockMovement } from "./cartonStock.js";
import { IN_STORE_STOCK_SQL } from "./shared.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 50;

type Row = Record<string, unknown>;
const text = (value: unknown): string => (value == null ? "" : String(value));

export interface CartonAdjustmentLineInput {
  readonly articleSizeId: string;
  readonly color: string;
  readonly direction: string;
  readonly cartons: number;
}

export interface CartonAdjustmentPostInput {
  readonly requestId: string;
  readonly kind: string;
  readonly businessDate: string;
  readonly reason: string;
  readonly remarks?: string | null;
  readonly lines: readonly CartonAdjustmentLineInput[];
  readonly postedBy: string;
  /** This computer's workstation; its code is stored on the document. */
  readonly workstationId?: string | null;
  readonly storeLocationId: string;
}

export interface CartonAdjustmentLine {
  readonly lineNo: number;
  readonly articleSizeId: string;
  readonly article: string;
  readonly size: string;
  readonly color: string;
  readonly direction: CartonAdjustmentDirection;
  readonly cartons: number;
  readonly eventId: string;
}

export interface CartonAdjustmentDocument {
  readonly id: string;
  readonly code: string;
  readonly documentNumber: number;
  readonly kind: CartonAdjustmentKind;
  readonly businessDate: string;
  readonly reason: string;
  readonly remarks: string | null;
  readonly postedBy: string;
  readonly workstationCode: string | null;
  readonly postedAt: string;
  readonly cartonsIn: number;
  readonly cartonsOut: number;
  readonly lines: readonly CartonAdjustmentLine[];
}

export interface CartonAdjustmentPostResult {
  readonly document: CartonAdjustmentDocument;
  readonly duplicate: boolean;
}

/** One colour of one size of an article, as the Stock Adjustment screen offers it. */
export interface CartonAdjustmentChoice {
  readonly articleSizeId: string;
  readonly size: string;
  readonly color: string;
  readonly inStore: number;
  readonly hasOpening: boolean;
}

export interface CartonAdjustmentPage {
  readonly documents: readonly CartonAdjustmentDocument[];
  readonly total: number;
  readonly page: number;
  readonly pages: number;
}

/** A refusal the screen shows as it is: nothing was written. */
export class CartonAdjustmentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartonAdjustmentRefused";
  }
}

interface CheckedDocument {
  readonly kind: CartonAdjustmentKind;
  readonly reason: string;
  readonly remarks: string | null;
  readonly lines: ReadonlyArray<CartonAdjustmentLineInput & { direction: CartonAdjustmentDirection }>;
}

function checkedLines(kind: CartonAdjustmentKind, lines: readonly CartonAdjustmentLineInput[]): CheckedDocument["lines"] {
  if (!Array.isArray(lines) || lines.length === 0) throw new CartonAdjustmentRefused("Enter at least one quantity.");
  if (lines.length > CARTON_ADJUSTMENT_MAX_LINES) throw new CartonAdjustmentRefused(`One document may hold at most ${CARTON_ADJUSTMENT_MAX_LINES} lines.`);
  return lines.map((line) => {
    if (!isCartonAdjustmentDirection(line.direction)) throw new CartonAdjustmentRefused("Choose whether each line adds cartons or takes them out.");
    if (kind === CARTON_ADJUSTMENT_KIND.OPENING && line.direction !== CARTON_ADJUSTMENT_DIRECTION.IN) {
      throw new CartonAdjustmentRefused("Opening stock only adds cartons. Use Stock Adjustment to take cartons out.");
    }
    const problem = cartonAdjustmentQuantityProblem(Number(line.cartons));
    if (problem) throw new CartonAdjustmentRefused(problem);
    return { ...line, cartons: Number(line.cartons), direction: line.direction };
  });
}

function checkedDocument(input: CartonAdjustmentPostInput): CheckedDocument {
  if (!UUID.test(text(input.requestId))) throw new CartonAdjustmentRefused("This document could not be identified. Nothing was changed. Try again.");
  if (!isCartonAdjustmentKind(input.kind)) throw new CartonAdjustmentRefused("Choose Opening Stock or Stock Adjustment.");
  if (!isBusinessDate(input.businessDate)) throw new CartonAdjustmentRefused("Enter the transaction date.");
  const reason = text(input.reason).trim();
  if (!reason) throw new CartonAdjustmentRefused("Give a reason. Every computer shows it with the movement.");
  if (!text(input.postedBy).trim()) throw new CartonAdjustmentRefused("This document must name who posted it.");
  if (!text(input.storeLocationId).trim()) throw new CartonAdjustmentRefused("This computer has no store set up, so it cannot hold carton stock.");
  const remarks = text(input.remarks).trim() || null;
  return { kind: input.kind, reason, remarks, lines: checkedLines(input.kind, input.lines) };
}

const toLine = (row: Row): CartonAdjustmentLine => ({
  lineNo: Number(row.line_no),
  articleSizeId: text(row.article_size_id),
  article: text(row.article),
  size: text(row.size),
  color: text(row.color),
  direction: text(row.direction) as CartonAdjustmentDirection,
  cartons: Number(row.cartons),
  eventId: text(row.carton_stock_event_id),
});

const sumOf = (lines: readonly CartonAdjustmentLine[], direction: CartonAdjustmentDirection): number =>
  lines.filter((line) => line.direction === direction).reduce((sum, line) => sum + line.cartons, 0);

export const cartonStockDocumentMethods = {
  /** Posts one document and moves the figure by every line, in one transaction. */
  postCartonStockAdjustment(this: SqliteDatabase, input: CartonAdjustmentPostInput): CartonAdjustmentPostResult {
    const checked = checkedDocument(input);
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      if (this.db.prepare("SELECT 1 AS here FROM carton_stock_adjustments WHERE id = ?").get(input.requestId)) {
        this.db.exec("COMMIT");
        return { document: this.getCartonStockAdjustment(input.requestId), duplicate: true };
      }
      this.insertCartonAdjustment(input, checked);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
    return { document: this.getCartonStockAdjustment(input.requestId), duplicate: false };
  },

  /** @internal The document and its lines and movements. Call ONLY inside BEGIN IMMEDIATE. */
  insertCartonAdjustment(this: SqliteDatabase, input: CartonAdjustmentPostInput, checked: CheckedDocument): void {
    const documentNumber = allocateNumberInRange(this, "cartonAdjustment");
    const code = formatCartonAdjustmentCode(documentNumber);
    const nowIso = new Date().toISOString();
    const postedBy = text(input.postedBy).trim();
    const workstation = this.db.prepare("SELECT workstation_code FROM workstations WHERE id = ?").get(text(input.workstationId)) as Row | undefined;
    this.db
      .prepare(
        `INSERT INTO carton_stock_adjustments (id, document_number, kind, business_date, reason, remarks, posted_by, workstation_code, stock_location_id, posted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.requestId, documentNumber, checked.kind, input.businessDate, checked.reason, checked.remarks, postedBy, workstation ? text(workstation.workstation_code) : null, input.storeLocationId, nowIso);
    const seen = new Set<string>();
    checked.lines.forEach((line, index) => {
      const variant = this.stockableVariant(line.articleSizeId, line.color);
      const name = `${variant.article} ${variant.size} ${variant.color}`;
      if (seen.has(variant.id)) throw new CartonAdjustmentRefused(`${name} is entered twice. Enter each colour and size once.`);
      seen.add(variant.id);
      if (checked.kind === CARTON_ADJUSTMENT_KIND.OPENING && this.hasOpeningStock(variant.id)) {
        throw new CartonAdjustmentRefused(`${name} already has opening stock. Use Stock Adjustment to correct it. Nothing was posted.`);
      }
      const eventId = crypto.randomUUID();
      try {
        recordCartonStockMovement(this.db, {
          eventId,
          variantId: variant.id,
          eventType: line.direction === CARTON_ADJUSTMENT_DIRECTION.OUT ? CARTON_STOCK_EVENT_TYPE.CARTON_ADJUST_OUT : CARTON_STOCK_EVENT_TYPE.CARTON_ADJUST_IN,
          cartons: line.cartons,
          locationId: input.storeLocationId,
          createdBy: postedBy,
          createdAt: nowIso,
          reason: `${code} ${checked.kind === CARTON_ADJUSTMENT_KIND.OPENING ? "Opening stock" : "Stock adjustment"}: ${checked.reason}`,
        });
      } catch (error) {
        if (error instanceof CartonStockWouldGoNegative) {
          throw new CartonAdjustmentRefused(`The store does not hold ${line.cartons} carton(s) of ${name}. Nothing was posted.`);
        }
        throw error;
      }
      this.db
        .prepare(
          `INSERT INTO carton_stock_adjustment_lines (id, adjustment_id, line_no, product_variant_id, article_size_id, article, size, color, direction, cartons, carton_stock_event_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(crypto.randomUUID(), input.requestId, index + 1, variant.id, variant.articleSizeId, variant.article, variant.size, variant.color, line.direction, line.cartons, eventId);
    });
  },

  /** @internal Whether a product's colour has been given opening stock, here or on the computer that posted it. */
  hasOpeningStock(this: SqliteDatabase, variantId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 AS here FROM carton_stock_adjustment_lines l JOIN carton_stock_adjustments a ON a.id = l.adjustment_id
            WHERE a.kind = ? AND l.product_variant_id = ? LIMIT 1`
        )
        .get(CARTON_ADJUSTMENT_KIND.OPENING, variantId)
    );
  },

  /** One article's active colours and sizes, each with its figure in store and whether it has opening stock. */
  cartonAdjustmentArticle(this: SqliteDatabase, article: string): CartonAdjustmentChoice[] {
    const rows = this.db
      .prepare(
        `SELECT a.id AS article_size_id, a.size, pv.color, ${IN_STORE_STOCK_SQL} AS in_store,
                EXISTS (SELECT 1 FROM carton_stock_adjustment_lines l JOIN carton_stock_adjustments d ON d.id = l.adjustment_id
                         WHERE d.kind = 'OPENING' AND l.product_variant_id = pv.id) AS has_opening
           FROM article_sizes a JOIN product_variants pv ON pv.article_size_id = a.id
          WHERE a.article = ? AND a.status = 'ACTIVE' AND a.deleted_at IS NULL
            AND pv.deleted_at IS NULL AND COALESCE(pv.status, 'ACTIVE') <> 'DISABLED'`
      )
      .all(text(article).trim()) as Row[];
    return rows.map((row) => ({
      articleSizeId: text(row.article_size_id),
      size: text(row.size),
      color: text(row.color),
      inStore: Number(row.in_store ?? 0),
      hasOpening: Number(row.has_opening) === 1,
    }));
  },

  /** One document with its lines. */
  getCartonStockAdjustment(this: SqliteDatabase, id: string): CartonAdjustmentDocument {
    const row = this.db.prepare("SELECT * FROM carton_stock_adjustments WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new CartonAdjustmentRefused("The document was not found.");
    const lines = (this.db.prepare("SELECT * FROM carton_stock_adjustment_lines WHERE adjustment_id = ? ORDER BY line_no").all(id) as Row[]).map(toLine);
    return {
      id: text(row.id),
      code: formatCartonAdjustmentCode(Number(row.document_number)),
      documentNumber: Number(row.document_number),
      kind: text(row.kind) as CartonAdjustmentKind,
      businessDate: text(row.business_date),
      reason: text(row.reason),
      remarks: row.remarks == null ? null : text(row.remarks),
      postedBy: text(row.posted_by),
      workstationCode: row.workstation_code == null ? null : text(row.workstation_code),
      postedAt: text(row.posted_at),
      cartonsIn: sumOf(lines, CARTON_ADJUSTMENT_DIRECTION.IN),
      cartonsOut: sumOf(lines, CARTON_ADJUSTMENT_DIRECTION.OUT),
      lines,
    };
  },

  /** The documents, newest first, a page at a time (R20). */
  listCartonStockAdjustments(this: SqliteDatabase, query: { page?: number; pageSize?: number } = {}): CartonAdjustmentPage {
    const pageSize = Math.min(Math.max(Math.trunc(query.pageSize ?? 20), 1), MAX_PAGE_SIZE);
    const total = Number((this.db.prepare("SELECT COUNT(*) AS n FROM carton_stock_adjustments").get() as Row).n);
    const pages = Math.max(Math.ceil(total / pageSize), 1);
    const page = Math.min(Math.max(Math.trunc(query.page ?? 1), 1), pages);
    const ids = this.db
      .prepare("SELECT id FROM carton_stock_adjustments ORDER BY posted_at DESC, document_number DESC LIMIT ? OFFSET ?")
      .all(pageSize, (page - 1) * pageSize) as Row[];
    return { documents: ids.map((row) => this.getCartonStockAdjustment(text(row.id))), total, page, pages };
  },
};

export type CartonStockDocumentMethods = typeof cartonStockDocumentMethods;
