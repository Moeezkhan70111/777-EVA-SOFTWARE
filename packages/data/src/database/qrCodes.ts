// QR code registry: generation, management (void / restore / damaged), journey and search.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance; bodies are unchanged from the original class.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { MAX_QR_BATCH_QUANTITY } from "./types.js";
import type { QrBatchRecord, QrCodeRecord, PagedResult, QrBatchMemberRow, QrDetail, QrGenerationFilter, QrGenerationFilterOptions, QrGenerationOverview, QrJourney, QrJourneyStep, QrJourneyStepKind, QrPlace, QrSearchRow, QrStage, QrStageCounts } from "./types.js";
import { GATE_LOCATION_TYPE, IN_STORE_LOCATION_TYPE, IN_STORE_STATUS, TO_GATE_STATUS } from "@erp/application";
import type { TransactionContext } from "@erp/application";
import type { MutableTransactionContext } from "./shared.js";
import { buildQrId, formatQrSerial, fromPaisaOrNull, isValidRawMaterialQrId, normalizeQrArticle, normalizeQrColor, normalizeQrSize } from "@erp/domain";

/**
 * SQL form of `qrStageOf` so grouped counts are derived by the database from the same two
 * facts — the registry row (`qr_codes.status`) and the live unit (`qr_master.current_status`)
 * — rather than from a separately maintained status column. Expects the aliases `b`
 * (qr_codes) and `qm` (qr_master, LEFT JOINed).
 */
const QR_STAGE_SQL =
  "CASE WHEN b.status = 'VOID' THEN 'VOID' WHEN qm.qr_id IS NULL THEN 'REGISTERED' ELSE qm.current_status END";

/** What one carton QR generation asks for. */
export interface QrBatchRequest {
  articleSizeId: string;
  color: string;
  quantity: number;
  createdBy?: string;
  requestedBy?: string;
}

export interface GeneratedQrBatch {
  batch: QrBatchRecord;
  qrCodes: QrCodeRecord[];
}

export const qrCodesMethods = {
  /**
   * Reserves the next N serials for an article+color+size combination and permanently records
   * each QR code identity.
   *
   * Concurrency: the whole reservation runs inside BEGIN IMMEDIATE, which takes SQLite's write
   * lock up front, so two simultaneous requests serialise rather than both reading the same
   * `last_sequence`. The counter is advanced with an atomic UPSERT (never MAX(serial)+1 over the
   * qr_codes table), and `qr_codes.id` — the QR value itself — is the PRIMARY KEY, so a duplicate
   * identity is impossible at the database level even if every layer above were wrong.
   */
  generateQrBatch(this: SqliteDatabase, input: QrBatchRequest): GeneratedQrBatch {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const generated = this.reserveQrBatchInTransaction(input);
      this.db.exec("COMMIT");
      return generated;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /**
   * The body of generateQrBatch, for a caller that already holds the write lock and has to record
   * something else in the SAME transaction as the identities — Machine Move Out's carton labels,
   * which must never exist without the packets they were printed for, or the other way round.
   *
   * Never call this outside BEGIN IMMEDIATE: the sequence read below relies on the lock.
   */
  reserveQrBatchInTransaction(this: SqliteDatabase, input: QrBatchRequest): GeneratedQrBatch {
    const rawQuantity = Number(input.quantity);
    if (!Number.isFinite(rawQuantity) || !Number.isInteger(rawQuantity)) {
      throw new Error("Quantity must be a whole number.");
    }
    const quantity = Math.trunc(rawQuantity);
    if (quantity <= 0) {
      throw new Error("Quantity must be at least 1.");
    }
    if (quantity > MAX_QR_BATCH_QUANTITY) {
      throw new Error(`Quantity cannot exceed ${MAX_QR_BATCH_QUANTITY} QR codes in one batch.`);
    }

    const color = normalizeQrColor(input.color);
    if (!color) {
      throw new Error("Color is required.");
    }

    const product = this.db
      .prepare("SELECT id, article, size FROM article_sizes WHERE id = ? AND deleted_at IS NULL LIMIT 1")
      .get(input.articleSizeId) as { id: string; article: string; size: string } | undefined;
    if (!product) {
      throw new Error("Selected product was not found in Product Master. Create it in Products first.");
    }

    const article = product.article;
    const size = product.size;

    // Fail before touching the database if the combination cannot be encoded as a scannable
    // identity — a registered QR code that the scanner cannot parse would be worthless.
    buildQrId({ article, color, size, sequence: 1 });

    const now = new Date().toISOString();
    const createdBy = String(input.createdBy ?? "").trim() || null;
    const requestedBy = String(input.requestedBy ?? "").trim().slice(0, 120) || null;

    const productVariantId = this.resolveVariantForColor(product, color, now);

    // Atomic counter advance: the new last_sequence is computed by the database, not read
    // into application code and written back.
    this.db
      .prepare(
        `INSERT INTO qr_sequences (id, article, color, size, last_sequence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(article, color, size) DO UPDATE SET
           last_sequence = qr_sequences.last_sequence + excluded.last_sequence,
           updated_at = excluded.updated_at`
      )
      .run(crypto.randomUUID(), article, color, size, quantity, now);

    const reserved = this.db
      .prepare("SELECT last_sequence FROM qr_sequences WHERE article = ? AND color = ? AND size = ?")
      .get(article, color, size) as { last_sequence: number } | undefined;
    if (!reserved) {
      throw new Error("Could not reserve a QR sequence.");
    }

    const endSequence = Number(reserved.last_sequence);
    const startSequence = endSequence - quantity + 1;

    const batchId = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO qr_batches (id, article_size_id, article, color, size, start_sequence, end_sequence, quantity, created_at, created_by, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(batchId, product.id, article, color, size, startSequence, endSequence, quantity, now, createdBy, requestedBy);

    const insertQrCode = this.db.prepare(
      `INSERT INTO qr_codes (id, batch_id, article, color, size, sequence, status, created_at, updated_at, product_variant_id)
       VALUES (?, ?, ?, ?, ?, ?, 'GENERATED', ?, ?, ?)`
    );
    const qrCodes: QrCodeRecord[] = [];
    for (let sequence = startSequence; sequence <= endSequence; sequence += 1) {
      const id = buildQrId({ article, color, size, sequence });
      insertQrCode.run(id, batchId, article, color, size, sequence, now, now, productVariantId);
      qrCodes.push({
        id,
        batchId,
        article,
        color,
        size,
        sequence,
        status: "GENERATED",
        createdAt: now,
        productVariantId,
      });
    }

    return {
      batch: {
        id: batchId,
        articleSizeId: product.id,
        article,
        color,
        size,
        startSequence,
        endSequence,
        quantity,
        createdAt: now,
        createdBy,
        requestedBy,
      },
      qrCodes,
    };
  },

  /**
   * Registry lookup used by the production scanner. Read-only by design: the scanner
   * confirms an identity exists here, it never creates one.
   */
  async findRegisteredQrCode(this: SqliteDatabase, 
    qrId: string,
    tx: TransactionContext
  ): Promise<{ productVariantId: string | null; article: string; color: string; size: string; status: string } | null> {
    const context = tx as MutableTransactionContext;
    const row = context.db
      .prepare("SELECT product_variant_id, article, color, size, status FROM qr_codes WHERE id = ? LIMIT 1")
      .get(qrId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      productVariantId: row.product_variant_id ? String(row.product_variant_id) : null,
      article: String(row.article),
      color: String(row.color),
      size: String(row.size),
      status: String(row.status ?? "GENERATED"),
    };
  },

  /**
   * Where the serial sequence currently stands for a combination, so the QR Generator can show
   * the exact range it is about to register before the operator commits. Read-only.
   */
  getQrSequenceState(this: SqliteDatabase, input: { articleSizeId: string; color: string }): {
    article: string;
    size: string;
    color: string;
    lastSequence: number;
    nextSequence: number;
  } | null {
    const color = normalizeQrColor(input.color);
    if (!color) return null;

    const product = this.db
      .prepare("SELECT article, size FROM article_sizes WHERE id = ? AND deleted_at IS NULL LIMIT 1")
      .get(input.articleSizeId) as { article: string; size: string } | undefined;
    if (!product) return null;

    const row = this.db
      .prepare("SELECT last_sequence FROM qr_sequences WHERE article = ? AND color = ? AND size = ?")
      .get(product.article, color, product.size) as { last_sequence: number } | undefined;

    const lastSequence = Number(row?.last_sequence ?? 0);
    return {
      article: product.article,
      size: product.size,
      color,
      lastSequence,
      nextSequence: lastSequence + 1,
    };
  },

  /** Colours already in use, for the QR Generator's colour picker. */
  listQrColors(this: SqliteDatabase): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT color FROM (
           SELECT color FROM product_variants WHERE deleted_at IS NULL AND color <> ''
           UNION
           SELECT color FROM qr_codes WHERE color <> ''
         ) ORDER BY color`
      )
      .all() as Array<{ color: string }>;
    return rows.map((row) => String(row.color));
  },

  /**
   * `sinceIso` filters to batches created at or after that instant (e.g. "last 7 days"),
   * evaluated against `qr_batches.created_at` using the existing index on that column.
   * Accepts a bare number for backward compatibility with the old `limit`-only signature.
   */
  listQrBatches(this: SqliteDatabase, input: number | { limit?: number; sinceIso?: string } = {}): QrBatchRecord[] {
    const opts = typeof input === "number" ? { limit: input } : input;
    const limit = Math.max(1, Math.trunc(opts.limit ?? 20));
    const params: Array<string | number> = [];
    let whereClause = "";
    if (opts.sinceIso) {
      whereClause = "WHERE created_at >= ?";
      params.push(opts.sinceIso);
    }
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT id, article_size_id, article, color, size, start_sequence, end_sequence, quantity, created_at, created_by, requested_by
         FROM qr_batches ${whereClause} ORDER BY created_at DESC LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      articleSizeId: row.article_size_id ? String(row.article_size_id) : null,
      article: String(row.article),
      color: String(row.color),
      size: String(row.size),
      startSequence: Number(row.start_sequence),
      endSequence: Number(row.end_sequence),
      quantity: Number(row.quantity),
      createdAt: String(row.created_at),
      createdBy: row.created_by ? String(row.created_by) : null,
      requestedBy: row.requested_by ? String(row.requested_by) : null,
    }));
  },

  listQrCodesForBatch(this: SqliteDatabase, batchId: string): QrCodeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, batch_id, article, color, size, sequence, status, created_at, product_variant_id
         FROM qr_codes WHERE batch_id = ? ORDER BY sequence ASC`
      )
      .all(batchId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      batchId: String(row.batch_id),
      article: String(row.article),
      color: String(row.color),
      size: String(row.size),
      sequence: Number(row.sequence),
      status: String(row.status),
      createdAt: String(row.created_at),
      productVariantId: row.product_variant_id ? String(row.product_variant_id) : null,
    }));
  },

  // ─── QR Management ───────────────────────────────────────────────────────────────
  // Read-side lookups over the registry (qr_codes), live state (qr_master) and the
  // append-only event log, plus the two management actions that have no scanner path:
  // voiding a code that was never produced, and writing off a produced unit as damaged.

  qrStageOf(this: SqliteDatabase, registryStatus: string | null, lifecycleStatus: string | null): QrStage {
    if (registryStatus === "VOID") return "VOID";
    if (!lifecycleStatus) return "REGISTERED";
    return lifecycleStatus as QrStage;
  },


  /** Rebuilds a registered identity for display; falls back to the plain shape for legacy data. */
  qrIdentityAt(this: SqliteDatabase, parts: { article: string; color: string; size: string }, sequence: number): string {
    try {
      return buildQrId({ ...parts, sequence });
    } catch {
      const serial = Number.isInteger(sequence) && sequence > 0 ? formatQrSerial(sequence) : String(sequence);
      return `${parts.article}_${parts.color}_${parts.size}_${serial}`;
    }
  },

  /**
   * Turns a local calendar day (YYYY-MM-DD) into the ISO instant it starts at on this
   * machine, matching how `getDashboardSnapshot` bounds "today". Timestamps are stored as
   * UTC ISO strings, so comparing against these bounds selects the local day exactly.
   */
  /** Local calendar day (YYYY-MM-DD) of an instant on this machine. */
  localYmd(this: SqliteDatabase, date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  },

  localDayStartIso(this: SqliteDatabase, ymd: string, dayOffset = 0): string | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? "").trim());
    if (!match) return null;
    const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + dayOffset, 0, 0, 0, 0);
    return Number.isNaN(start.getTime()) ? null : start.toISOString();
  },

  /** WHERE fragment + params for the batch-level filters of the QR Management overview. */
  qrGenerationWhere(this: SqliteDatabase, filter: QrGenerationFilter): { where: string; params: Array<string | number> } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    // Generation time only — never scan, print or last-activity time.
    const fromIso = filter.fromDate ? this.localDayStartIso(filter.fromDate) : null;
    const toIso = filter.toDate ? this.localDayStartIso(filter.toDate, 1) : null;
    if (fromIso) {
      clauses.push("bb.created_at >= ?");
      params.push(fromIso);
    }
    if (toIso) {
      clauses.push("bb.created_at < ?");
      params.push(toIso);
    }

    // Same normalisation the generator wrote with, so "sk6" / "Red " / "7 / 10" still match.
    const article = filter.article ? normalizeQrArticle(filter.article) : "";
    const color = filter.color ? normalizeQrColor(filter.color) : "";
    const size = filter.size ? normalizeQrSize(filter.size) : "";
    if (article) {
      clauses.push("bb.article = ?");
      params.push(article);
    }
    if (color) {
      clauses.push("bb.color = ?");
      params.push(color);
    }
    if (size) {
      clauses.push("bb.size = ?");
      params.push(size);
    }

    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  },

  /**
   * The QR Management overview: one row per generation run, filtered by generation date
   * and/or article/colour/size (all ANDed), with per-run and overall stage tallies.
   *
   * Works at the batch grain so the grouped table is a page over `qr_batches` (one row
   * per run, however large) and only the runs on the current page have their codes counted.
   * The headline tallies cover every code in the filter, computed by the database in one
   * GROUP BY — no individual code is ever sent to the caller from here.
   */
  getQrGenerationOverview(this: SqliteDatabase, filter: QrGenerationFilter = {}): QrGenerationOverview {
    const page = Math.max(1, Math.trunc(filter.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.trunc(filter.pageSize ?? 25)));
    const offset = (page - 1) * pageSize;
    const { where, params } = this.qrGenerationWhere(filter);

    const total = this.scalarCount(`SELECT COUNT(1) AS c FROM qr_batches bb ${where}`, params);

    const batchRows = this.db
      .prepare(
        `SELECT bb.id, bb.article, bb.color, bb.size, bb.start_sequence, bb.end_sequence, bb.quantity,
                bb.created_at, bb.created_by, bb.requested_by
         FROM qr_batches bb ${where}
         ORDER BY bb.created_at DESC, bb.article ASC, bb.color ASC, bb.size ASC, bb.start_sequence DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset) as Array<Record<string, unknown>>;

    // Stage tallies for just the runs on this page.
    const countsByBatch = new Map<string, QrStageCounts>();
    if (batchRows.length > 0) {
      const ids = batchRows.map((row) => String(row.id));
      const placeholders = ids.map(() => "?").join(", ");
      const countRows = this.db
        .prepare(
          `SELECT b.batch_id, ${QR_STAGE_SQL} AS stage, COUNT(1) AS n
           FROM qr_codes b
           LEFT JOIN qr_master qm ON qm.qr_id = b.id
           WHERE b.batch_id IN (${placeholders})
           GROUP BY b.batch_id, stage`
        )
        .all(...ids) as Array<{ batch_id: string; stage: string; n: number }>;
      for (const row of countRows) {
        const bucket = countsByBatch.get(String(row.batch_id)) ?? {};
        bucket[String(row.stage) as QrStage] = Number(row.n);
        countsByBatch.set(String(row.batch_id), bucket);
      }
    }

    // Headline tallies across every code in the filter, not just this page.
    let stageCounts: QrStageCounts | null = null;
    let totalQrCount: number | null = null;
    if (filter.includeSummary !== false) {
      const overallRows = this.db
        .prepare(
          `SELECT ${QR_STAGE_SQL} AS stage, COUNT(1) AS n
           FROM qr_batches bb
           JOIN qr_codes b ON b.batch_id = bb.id
           LEFT JOIN qr_master qm ON qm.qr_id = b.id
           ${where}
           GROUP BY stage`
        )
        .all(...params) as Array<{ stage: string; n: number }>;
      stageCounts = {};
      totalQrCount = 0;
      for (const row of overallRows) {
        stageCounts[String(row.stage) as QrStage] = Number(row.n);
        totalQrCount += Number(row.n);
      }
    }

    return {
      groups: batchRows.map((row) => {
        const parts = { article: String(row.article), color: String(row.color), size: String(row.size) };
        return {
          batchId: String(row.id),
          ...parts,
          startSequence: Number(row.start_sequence),
          endSequence: Number(row.end_sequence),
          quantity: Number(row.quantity),
          firstQrId: this.qrIdentityAt(parts, Number(row.start_sequence)),
          lastQrId: this.qrIdentityAt(parts, Number(row.end_sequence)),
          generatedAt: String(row.created_at),
          generatedBy: row.created_by ? String(row.created_by) : null,
          requestedBy: row.requested_by ? String(row.requested_by) : null,
          stageCounts: countsByBatch.get(String(row.id)) ?? {},
        };
      }),
      total,
      page,
      pageSize,
      totalQrCount,
      stageCounts,
    };
  },

  /** Distinct values ever generated, for the overview's Article / Colour / Size pickers. */
  listQrGenerationFilterOptions(this: SqliteDatabase): QrGenerationFilterOptions {
    const distinct = (column: "article" | "color" | "size") =>
      (this.db
        .prepare(`SELECT DISTINCT ${column} AS v FROM qr_batches WHERE ${column} <> '' ORDER BY ${column} ASC`)
        .all() as Array<{ v: string }>).map((row) => String(row.v));
    return { articles: distinct("article"), colors: distinct("color"), sizes: distinct("size") };
  },

  /**
   * The individual codes of one generation run, in serial order, with each code's current
   * stage derived the same way as everywhere else. Paged so a 10,000-code run is fetched a
   * screen at a time when the operator expands it.
   */
  listQrBatchMembers(this: SqliteDatabase, batchId: string, opts: { page?: number; pageSize?: number } = {}): PagedResult<QrBatchMemberRow> {
    const id = String(batchId ?? "").trim();
    const page = Math.max(1, Math.trunc(opts.page ?? 1));
    const pageSize = Math.min(1000, Math.max(1, Math.trunc(opts.pageSize ?? 100)));
    const offset = (page - 1) * pageSize;
    if (!id) return { rows: [], total: 0, page, pageSize };

    const total = this.scalarCount("SELECT COUNT(1) AS c FROM qr_codes WHERE batch_id = ?", [id]);
    const rows = this.db
      .prepare(
        `SELECT b.id, b.sequence, b.created_at, ${QR_STAGE_SQL} AS stage,
                qm.updated_at AS qm_updated_at
         FROM qr_codes b
         LEFT JOIN qr_master qm ON qm.qr_id = b.id
         WHERE b.batch_id = ?
         ORDER BY b.sequence ASC
         LIMIT ? OFFSET ?`
      )
      .all(id, pageSize, offset) as Array<Record<string, unknown>>;

    return {
      rows: rows.map((row) => ({
        qrId: String(row.id),
        sequence: Number(row.sequence),
        stage: String(row.stage) as QrStage,
        lastActivityAt: String(row.qm_updated_at ?? row.created_at),
      })),
      total,
      page,
      pageSize,
    };
  },

  /**
   * Substring search over the QR value itself. Every whitespace-separated term must match,
   * so "sk6 red 42" finds SK6_RED_7/10_000042. LIKE wildcards in the input are escaped.
   */
  searchQrCodes(this: SqliteDatabase, query: string, limit = 50): QrSearchRow[] {
    const terms = String(query ?? "")
      .trim()
      .toUpperCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6);
    if (terms.length === 0) return [];

    const escape = (term: string) => term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const where = terms.map(() => "b.id LIKE ? ESCAPE '\\'").join(" AND ");
    const params: Array<string | number> = terms.map((t) => `%${escape(t)}%`);
    params.push(Math.min(Math.max(1, Math.trunc(limit)), 500));

    const rows = this.db
      .prepare(
        `SELECT b.id, b.article, b.color, b.size, b.sequence, b.batch_id, b.status, b.created_at,
                qm.current_status, qm.updated_at AS qm_updated_at
         FROM qr_codes b
         LEFT JOIN qr_master qm ON qm.qr_id = b.id
         WHERE ${where}
         ORDER BY b.created_at DESC, b.sequence DESC
         LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>;

    const toSearchRow = (row: Record<string, unknown>): QrSearchRow => ({
      qrId: String(row.id),
      article: String(row.article),
      color: String(row.color),
      size: String(row.size),
      sequence: Number(row.sequence),
      batchId: String(row.batch_id),
      registeredAt: String(row.created_at),
      stage: this.qrStageOf(
        row.status ? String(row.status) : null,
        row.current_status ? String(row.current_status) : null
      ),
      lastActivityAt: String(row.qm_updated_at ?? row.created_at),
    });

    // Raw material packets are searched the same way and merged into one result list, so
    // the operator never has to know which registry a code came from.
    return [...rows.map(toSearchRow), ...this.searchRawMaterialQrs(terms, limit)]
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .slice(0, Math.min(Math.max(1, Math.trunc(limit)), 500));
  },

  /** Everything recorded about one QR: identity, registration, batch, live state, and full event log. */
  getQrDetail(this: SqliteDatabase, qrId: string): QrDetail | null {
    // A raw material packet lives in its own registry and event log; it is read here so QR
    // Management stays one screen for every kind of code the business issues.
    if (isValidRawMaterialQrId(String(qrId ?? "").trim().toUpperCase())) {
      return this.getRawMaterialQrDetail(String(qrId).trim().toUpperCase());
    }
    const id = String(qrId ?? "").trim().toUpperCase();
    if (!id) return null;

    const qrCode = this.db
      .prepare(
        `SELECT id, batch_id, article, color, size, sequence, status, created_at, product_variant_id,
                void_reason, voided_at, voided_by
         FROM qr_codes WHERE id = ? LIMIT 1`
      )
      .get(id) as Record<string, unknown> | undefined;

    const master = this.db
      .prepare(
        `SELECT qm.qr_id, qm.product_variant_id, qm.current_status, qm.current_location_type,
                qm.current_location_id, qm.created_at, qm.updated_at, pv.article, pv.color, pv.size
         FROM qr_master qm
         JOIN product_variants pv ON pv.id = qm.product_variant_id
         WHERE qm.qr_id = ? LIMIT 1`
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!qrCode && !master) return null;

    const article = String(qrCode?.article ?? master?.article ?? "");
    const color = String(qrCode?.color ?? master?.color ?? "");
    const size = String(qrCode?.size ?? master?.size ?? "");
    const productVariantId = qrCode?.product_variant_id
      ? String(qrCode.product_variant_id)
      : master?.product_variant_id
        ? String(master.product_variant_id)
        : null;

    const variant = productVariantId
      ? (this.db
          .prepare(
            `SELECT pv.selling_price_paisa, COALESCE(spv.quantity_on_hand, 0) AS on_hand
             FROM product_variants pv
             LEFT JOIN stock_projection_by_variant spv ON spv.product_variant_id = pv.id
             WHERE pv.id = ? LIMIT 1`
          )
          .get(productVariantId) as { selling_price_paisa: number | null; on_hand: number } | undefined)
      : undefined;

    let batch: QrDetail["batch"] = null;
    if (qrCode?.batch_id) {
      const batchRow = this.db
        .prepare(
          `SELECT bb.id, bb.start_sequence, bb.end_sequence, bb.quantity, bb.created_at, bb.created_by, bb.requested_by,
                  (SELECT COUNT(1) FROM qr_codes b JOIN qr_master q ON q.qr_id = b.id WHERE b.batch_id = bb.id) AS produced_count,
                  (SELECT COUNT(1) FROM qr_codes b WHERE b.batch_id = bb.id AND b.status = 'VOID') AS void_count
           FROM qr_batches bb WHERE bb.id = ? LIMIT 1`
        )
        .get(String(qrCode.batch_id)) as Record<string, unknown> | undefined;
      if (batchRow) {
        batch = {
          id: String(batchRow.id),
          startSequence: Number(batchRow.start_sequence),
          endSequence: Number(batchRow.end_sequence),
          quantity: Number(batchRow.quantity),
          createdAt: String(batchRow.created_at),
          createdBy: batchRow.created_by ? String(batchRow.created_by) : null,
          requestedBy: batchRow.requested_by ? String(batchRow.requested_by) : null,
          producedCount: Number(batchRow.produced_count ?? 0),
          voidCount: Number(batchRow.void_count ?? 0),
        };
      }
    }

    const events = (
      this.db
        .prepare(
          `SELECT pe.id, pe.event_type, pe.event_ts_local, pe.device_id, pe.metadata_json, pe.sync_status,
                  f.name AS factory_name, w.name AS workstation_name, op.display_name AS operator_name
           FROM production_events pe
           LEFT JOIN factories f ON f.id = pe.factory_id
           LEFT JOIN workstations w ON w.id = pe.workstation_id
           LEFT JOIN operators op ON op.id = pe.operator_id
           WHERE pe.qr_id = ?
           ORDER BY pe.event_ts_local ASC, pe.created_at ASC`
        )
        .all(id) as Array<Record<string, unknown>>
    ).map((row) => {
      let note: string | null = null;
      let subType: string | null = null;
      if (row.metadata_json) {
        try {
          const meta = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
          if (typeof meta.reason === "string" && meta.reason.trim()) note = meta.reason.trim();
          // Only a metadata eventType that differs from the column is a real sub-kind
          // (e.g. MOVED written by Store Scanning as STORE_ENTRY).
          if (typeof meta.eventType === "string" && meta.eventType && meta.eventType !== String(row.event_type)) {
            subType = meta.eventType;
          }
          if (subType === "STORE_ENTRY" || subType === "STORE_EXIT") {
            const actor = typeof meta.actor === "string" && meta.actor.trim() ? ` · by ${meta.actor.trim()}` : "";
            const defaultTo = subType === "STORE_EXIT" ? GATE_LOCATION_TYPE : IN_STORE_LOCATION_TYPE;
            note = `${String(meta.fromLocationType ?? "FACTORY")} → ${String(meta.toLocationType ?? defaultTo)}${actor}`;
          }
        } catch {
          /* metadata is informational only */
        }
      }
      return {
        id: String(row.id),
        eventType: String(row.event_type),
        subType,
        occurredAt: String(row.event_ts_local),
        factory: row.factory_name ? String(row.factory_name) : null,
        workstation: row.workstation_name ? String(row.workstation_name) : null,
        operator: row.operator_name ? String(row.operator_name) : null,
        deviceId: String(row.device_id ?? ""),
        note,
        syncStatus: String(row.sync_status ?? "PENDING"),
      };
    });

    const registryStatus = qrCode ? String(qrCode.status ?? "GENERATED") : null;
    const lifecycleStatus = master ? String(master.current_status) : null;
    const serialMatch = id.match(/_([0-9]+)$/);

    return {
      qrId: id,
      article,
      color,
      size,
      serial: qrCode ? String(qrCode.sequence).padStart(6, "0") : (serialMatch?.[1] ?? ""),
      stage: this.qrStageOf(registryStatus, lifecycleStatus),
      productVariantId,
      sellingPrice: variant ? fromPaisaOrNull(variant.selling_price_paisa) : null,
      stockOnHand: variant ? Number(variant.on_hand) : null,
      registry: qrCode
        ? {
            status: registryStatus ?? "GENERATED",
            registeredAt: String(qrCode.created_at),
            voidReason: qrCode.void_reason ? String(qrCode.void_reason) : null,
            voidedAt: qrCode.voided_at ? String(qrCode.voided_at) : null,
            voidedBy: qrCode.voided_by ? String(qrCode.voided_by) : null,
          }
        : null,
      batch,
      lifecycle: master
        ? {
            currentStatus: String(master.current_status),
            locationType: String(master.current_location_type ?? "UNKNOWN"),
            locationId: master.current_location_id ? String(master.current_location_id) : null,
            firstScannedAt: String(master.created_at),
            updatedAt: String(master.updated_at),
          }
        : null,
      events,
    };
  },

  /** The physical place a status implies; DAMAGED / SCRAPPED keep whatever place they had. */
  placeForStatus(this: SqliteDatabase, status: string | null, previous: QrPlace | null): QrPlace | null {
    switch (status) {
      case "PRODUCED":
      case "RETURNED":
        return "FACTORY";
      case "WAREHOUSE":
        return "WAREHOUSE";
      case "TO_GATE":
      // A carton whose return has been recorded is standing at the gate: off the customer,
      // not yet received by the store.
      case "ON_GATE":
        return "GATE";
      case "DISPATCHED":
      case "SOLD":
        return "CUSTOMER";
      case "DAMAGED":
      case "SCRAPPED":
        return previous;
      default:
        return null;
    }
  },

  asPlace(this: SqliteDatabase, value: unknown): QrPlace | null {
    return value === "FACTORY" || value === "WAREHOUSE" || value === "GATE" || value === "CUSTOMER" ? value : null;
  },

  /**
   * The whole path one code has taken — registration, then every scan in order, each hop
   * spelled out as from → to status and place. Store hops carry their transition in the
   * event metadata; every other hop is implied by its event type, so the walk below keeps a
   * running status and never has to guess.
   */
  getQrJourney(this: SqliteDatabase, qrId: string): QrJourney | null {
    const id = String(qrId ?? "").trim().toUpperCase();
    if (!id) return null;
    if (isValidRawMaterialQrId(id)) return this.getRawMaterialQrJourney(id);

    const qrCode = this.db
      .prepare(
        `SELECT id, batch_id, article, color, size, sequence, status, created_at, void_reason, voided_at, voided_by
         FROM qr_codes WHERE id = ? LIMIT 1`
      )
      .get(id) as Record<string, unknown> | undefined;

    const master = this.db
      .prepare(
        `SELECT qm.current_status, qm.current_location_type, qm.created_at, qm.updated_at, pv.article, pv.color, pv.size
         FROM qr_master qm
         JOIN product_variants pv ON pv.id = qm.product_variant_id
         WHERE qm.qr_id = ? LIMIT 1`
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!qrCode && !master) return null;

    const rows = this.db
      .prepare(
        `SELECT pe.id, pe.event_type, pe.event_ts_local, pe.device_id, pe.metadata_json, pe.sync_status,
                f.name AS factory_name, w.name AS workstation_name, op.display_name AS operator_name
         FROM production_events pe
         LEFT JOIN factories f ON f.id = pe.factory_id
         LEFT JOIN workstations w ON w.id = pe.workstation_id
         LEFT JOIN operators op ON op.id = pe.operator_id
         WHERE pe.qr_id = ?
         ORDER BY pe.event_ts_local ASC, pe.created_at ASC`
      )
      .all(id) as Array<Record<string, unknown>>;

    const steps: QrJourneyStep[] = [];
    let status: string | null = null;
    let place: QrPlace | null = null;
    let previousAt: string | null = null;

    const pushStep = (step: Omit<QrJourneyStep, "index" | "sinceMs">) => {
      const sinceMs = previousAt ? Math.max(0, new Date(step.occurredAt).getTime() - new Date(previousAt).getTime()) : null;
      steps.push({ ...step, index: steps.length + 1, sinceMs: Number.isFinite(sinceMs as number) ? sinceMs : null });
      previousAt = step.occurredAt;
      status = step.toStatus;
      place = step.toPlace;
    };

    if (qrCode) {
      pushStep({
        id: `registered:${id}`,
        kind: "REGISTERED",
        eventType: null,
        occurredAt: String(qrCode.created_at),
        fromStatus: null,
        toStatus: "REGISTERED",
        fromPlace: null,
        toPlace: null,
        actor: null,
        deviceId: null,
        workstation: null,
        factory: null,
        note: null,
        syncStatus: null,
      });
    }

    // A void is a registry fact with its own timestamp. It only ever applies to a code with
    // no unit, so it sits right after registration, before any (impossible) scans.
    if (qrCode && qrCode.status === "VOID" && !master) {
      pushStep({
        id: `void:${id}`,
        kind: "VOID",
        eventType: null,
        occurredAt: String(qrCode.voided_at ?? qrCode.created_at),
        fromStatus: "REGISTERED",
        toStatus: "VOID",
        fromPlace: null,
        toPlace: null,
        actor: qrCode.voided_by ? String(qrCode.voided_by) : null,
        deviceId: null,
        workstation: null,
        factory: null,
        note: qrCode.void_reason ? String(qrCode.void_reason) : null,
        syncStatus: null,
      });
    }

    for (const row of rows) {
      const eventType = String(row.event_type);
      let meta: Record<string, unknown> = {};
      if (row.metadata_json) {
        try {
          meta = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
        } catch {
          /* metadata is informational only */
        }
      }
      const subType = typeof meta.eventType === "string" && meta.eventType !== eventType ? meta.eventType : null;

      let kind: QrJourneyStepKind;
      let toStatus: string;
      switch (eventType) {
        case "PRODUCED":
          kind = "PRODUCED";
          toStatus = "PRODUCED";
          break;
        case "DISPATCHED":
          kind = "DISPATCHED";
          toStatus = "DISPATCHED";
          break;
        case "RETURNED":
          kind = "RETURNED";
          // A return recorded on the gate leaves the carton ON_GATE, not back in stock. Legacy
          // RETURNED events (written before that split) carry no newStatus and still read as
          // ending in RETURNED, which is exactly where they left their carton.
          toStatus = typeof meta.newStatus === "string" ? meta.newStatus : "RETURNED";
          break;
        case "DAMAGED":
          kind = "DAMAGED";
          toStatus = "DAMAGED";
          break;
        case "SOLD":
          kind = "SOLD";
          toStatus = "SOLD";
          break;
        case "MOVED":
          if (subType === "STORE_ENTRY") {
            kind = "STORE_ENTRY";
            toStatus = typeof meta.newStatus === "string" ? meta.newStatus : IN_STORE_STATUS;
          } else if (subType === "STORE_EXIT") {
            kind = "STORE_EXIT";
            toStatus = typeof meta.newStatus === "string" ? meta.newStatus : TO_GATE_STATUS;
          } else {
            kind = "MOVED";
            toStatus = status ?? "PRODUCED";
          }
          break;
        case "PACKED":
          kind = "PACKED";
          toStatus = status ?? "PRODUCED";
          break;
        default:
          kind = "ADJUSTMENT";
          toStatus = status ?? "PRODUCED";
          break;
      }

      const fromStatus = typeof meta.previousStatus === "string" ? meta.previousStatus : status;
      const fromPlace = this.asPlace(meta.fromLocationType) ?? place;
      const toPlace = this.asPlace(meta.toLocationType) ?? this.placeForStatus(toStatus, fromPlace);
      const actor =
        typeof meta.actor === "string" && meta.actor.trim()
          ? meta.actor.trim()
          : row.operator_name
            ? String(row.operator_name)
            : null;

      pushStep({
        id: String(row.id),
        kind,
        eventType,
        occurredAt: String(row.event_ts_local),
        fromStatus,
        toStatus,
        fromPlace,
        toPlace,
        actor,
        deviceId: row.device_id ? String(row.device_id) : null,
        workstation: row.workstation_name ? String(row.workstation_name) : null,
        factory: row.factory_name ? String(row.factory_name) : null,
        note: typeof meta.reason === "string" && meta.reason.trim() ? meta.reason.trim() : null,
        syncStatus: row.sync_status ? String(row.sync_status) : null,
      });
    }

    const asOf = new Date().toISOString();
    const counts: Partial<Record<QrJourneyStepKind, number>> = {};
    const dwellMs: Record<string, number> = {};
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      counts[step.kind] = (counts[step.kind] ?? 0) + 1;
      const until = i + 1 < steps.length ? steps[i + 1].occurredAt : asOf;
      const span = new Date(until).getTime() - new Date(step.occurredAt).getTime();
      if (Number.isFinite(span) && span > 0) dwellMs[step.toStatus] = (dwellMs[step.toStatus] ?? 0) + span;
    }

    const registryStatus = qrCode ? String(qrCode.status ?? "GENERATED") : null;
    const lifecycleStatus = master ? String(master.current_status) : null;
    const serialMatch = id.match(/_([0-9]+)$/);
    const lastStep = steps[steps.length - 1];

    return {
      qrId: id,
      article: String(qrCode?.article ?? master?.article ?? ""),
      color: String(qrCode?.color ?? master?.color ?? ""),
      size: String(qrCode?.size ?? master?.size ?? ""),
      serial: qrCode ? String(qrCode.sequence).padStart(6, "0") : (serialMatch?.[1] ?? ""),
      stage: this.qrStageOf(registryStatus, lifecycleStatus),
      currentStatus: lifecycleStatus,
      // The live status says where the unit is now; only a write-off (which changes no
      // location) falls back to the row's location type, then to the walk.
      currentPlace: master
        ? this.placeForStatus(lifecycleStatus, this.asPlace(master.current_location_type) ?? place)
        : null,
      registeredAt: qrCode ? String(qrCode.created_at) : null,
      batchId: qrCode?.batch_id ? String(qrCode.batch_id) : null,
      firstScannedAt: master ? String(master.created_at) : null,
      lastActivityAt: lastStep ? lastStep.occurredAt : null,
      steps,
      counts,
      dwellMs,
      asOf,
    };
  },

  /**
   * Withdraws a registered code that has never been produced (lost/spoiled label). The
   * scanner then refuses it. A code already in qr_master cannot be voided — its unit exists.
   */
  voidQrCode(this: SqliteDatabase, input: { qrId: string; reason: string; actor?: string | null }): void {
    const id = String(input.qrId ?? "").trim().toUpperCase();
    const reason = String(input.reason ?? "").trim();
    if (!id) throw new Error("QR code is required.");
    if (!reason) throw new Error("A reason is required to void a code.");

    const qrCode = this.db
      .prepare("SELECT status FROM qr_codes WHERE id = ? LIMIT 1")
      .get(id) as { status: string } | undefined;
    if (!qrCode) throw new Error("This code is not registered.");
    if (qrCode.status === "VOID") throw new Error("This code is already void.");

    const produced = this.db.prepare("SELECT 1 AS ok FROM qr_master WHERE qr_id = ? LIMIT 1").get(id);
    if (produced) {
      throw new Error("This code has already been scanned into production and cannot be voided. Mark the unit damaged instead.");
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE qr_codes SET status = 'VOID', void_reason = ?, voided_at = ?, voided_by = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(reason, now, input.actor ?? null, now, id);
  },

  /** Reverses a void so the code can be produced again. Only a VOID code can be restored. */
  restoreQrCode(this: SqliteDatabase, input: { qrId: string }): void {
    const id = String(input.qrId ?? "").trim().toUpperCase();
    if (!id) throw new Error("QR code is required.");

    const qrCode = this.db
      .prepare("SELECT status FROM qr_codes WHERE id = ? LIMIT 1")
      .get(id) as { status: string } | undefined;
    if (!qrCode) throw new Error("This code is not registered.");
    if (qrCode.status !== "VOID") throw new Error("This code is not void.");

    this.db
      .prepare(
        `UPDATE qr_codes SET status = 'GENERATED', void_reason = NULL, voided_at = NULL, voided_by = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), id);
  },

  /**
   * Writes off a produced unit that is still in stock. Appends a DAMAGED event, moves the
   * unit's qr_master status, and moves one unit from on-hand to damaged in the projections —
   * the same shape the scan flows use, so reports and sync see it as a normal event.
   */
  markQrCodeDamaged(this: SqliteDatabase, input: {
    qrId: string;
    reason: string;
    actor?: string | null;
    context: { factoryId: string; workstationId: string; deviceId: string };
  }): { eventId: string } {
    const id = String(input.qrId ?? "").trim().toUpperCase();
    const reason = String(input.reason ?? "").trim();
    if (!id) throw new Error("QR code is required.");
    if (!reason) throw new Error("A reason is required to mark a unit damaged.");

    const master = this.db
      .prepare(
        `SELECT qm.product_variant_id, qm.current_status, qm.current_location_type, qm.current_location_id,
                pv.article, pv.color, pv.size
         FROM qr_master qm JOIN product_variants pv ON pv.id = qm.product_variant_id
         WHERE qm.qr_id = ? LIMIT 1`
      )
      .get(id) as
      | { product_variant_id: string; current_status: string; current_location_type: string | null; current_location_id: string | null; article: string; color: string; size: string }
      | undefined;

    if (!master) {
      const registered = this.db.prepare("SELECT 1 AS ok FROM qr_codes WHERE id = ? LIMIT 1").get(id);
      throw new Error(
        registered
          ? "This code has not been produced yet. Void the code instead."
          : "This code is not registered."
      );
    }
    if (master.current_status === "DAMAGED" || master.current_status === "SCRAPPED") {
      throw new Error(`This unit is already marked ${master.current_status.toLowerCase()}.`);
    }
    if (master.current_status === "DISPATCHED" || master.current_status === "SOLD") {
      throw new Error("This unit is with the customer. Record a return before marking it damaged.");
    }

    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    const serial = id.match(/_([0-9]+)$/)?.[1] ?? "";

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db
        .prepare(
          `INSERT INTO production_events (
            id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
            factory_id, workstation_id, operator_id, device_id,
            article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
            metadata_json, created_at, sync_status, synced_at, sync_error, retry_count, source_app
          ) VALUES (?, ?, ?, 'DAMAGED', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, 0, 'desktop-qr-management')`
        )
        .run(
          eventId,
          id,
          master.product_variant_id,
          now,
          now.slice(0, 10),
          new Date(now).getHours(),
          input.context.factoryId,
          input.context.workstationId,
          input.context.deviceId,
          master.article,
          master.color,
          master.size,
          serial,
          JSON.stringify({ eventType: "DAMAGED", reason, actor: input.actor ?? null }),
          now
        );

      this.db
        .prepare("UPDATE qr_master SET current_status = 'DAMAGED', updated_at = ? WHERE qr_id = ?")
        .run(now, id);

      // quantity_on_hand carries a CHECK (>= 0); clamp rather than fail on an already-drifted projection.
      this.db
        .prepare(
          `UPDATE stock_projection_by_variant
           SET quantity_on_hand = MAX(quantity_on_hand - 1, 0),
               quantity_damaged = quantity_damaged + 1,
               last_event_ts = ?, updated_at = ?
           WHERE product_variant_id = ?`
        )
        .run(now, now, master.product_variant_id);
      // Take it from wherever the unit sits (factory, or the store after Store Scanning).
      const damagedLocationType =
        master.current_location_type && master.current_location_type !== "UNKNOWN" ? master.current_location_type : "FACTORY";
      this.db
        .prepare(
          `UPDATE stock_projection_by_location
           SET quantity_on_hand = MAX(quantity_on_hand - 1, 0), updated_at = ?
           WHERE product_variant_id = ? AND location_type = ? AND location_id = ?`
        )
        .run(now, master.product_variant_id, damagedLocationType, master.current_location_id ?? input.context.factoryId);

      this.db
        .prepare(
          `INSERT INTO sync_outbox (
            id, aggregate_type, aggregate_id, operation, dedupe_key,
            payload_json, status, lock_token, available_at, attempts, last_error, created_at, updated_at
          ) VALUES (?, 'PRODUCTION_EVENT', ?, 'INSERT', ?, ?, 'PENDING', NULL, ?, 0, NULL, ?, ?)`
        )
        .run(
          outboxId,
          eventId,
          `PRODUCTION_EVENT:${eventId}`,
          JSON.stringify({
            eventId,
            qrId: id,
            eventType: "DAMAGED",
            reason,
            factoryId: input.context.factoryId,
            workstationId: input.context.workstationId,
            deviceId: input.context.deviceId,
            createdAt: now,
          }),
          now,
          now,
          now
        );

      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }

    return { eventId };
  },
};

export type QrCodesMethods = typeof qrCodesMethods;
