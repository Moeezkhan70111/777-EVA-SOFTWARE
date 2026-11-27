// A NEW COLOUR ASKED FOR FROM ENTER ORDERS (owner, 27 Nov 2026: "MAKE BOSS PC CAN ALSO ADD NEW COLOR IN ENTER ORDERS",
// "AUTO ACCEPT IT FROM PC1"). Local 121, cloud 043.
//
//   requestArticleColor        on the orders computer (ORDERS lease, PC3): checks the colour as "+ New colour" would,
//                              and writes a request, once per article and colour. It travels to every computer.
//   applyArticleColorRequests  on the Product Master computer (MASTER_DATA, PC1), after each pull: every request not
//                              yet dealt with goes through addColorToArticle, the same call as its own "+ New colour",
//                              so the colour lands on every active size and travels back. Nobody accepts anything.
//                              A refusal (no such article) is noted and not tried again.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import { randomUUID } from "node:crypto";
import { normalizeQrColor } from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import { CartonAdjustmentRefused, cleanColourName } from "./cartonStockDocuments.js";
import { holdsProductMaster } from "./hrColours.js";

export const ARTICLE_COLOR_REQUEST_STATUS = {
  /** Written, on its way to the Product Master computer. */
  REQUESTED: "REQUESTED",
  /** Nothing to ask: the article already has the colour (under any spacing). */
  ALREADY_THERE: "ALREADY_THERE",
} as const;
export type ArticleColorRequestStatus = (typeof ARTICLE_COLOR_REQUEST_STATUS)[keyof typeof ARTICLE_COLOR_REQUEST_STATUS];

export interface ArticleColorRequestResult {
  readonly status: ArticleColorRequestStatus;
  /** The colour as stored, or as the article already holds it. */
  readonly color: string;
}

const COMPACT_COLOUR_SQL = "REPLACE(REPLACE(REPLACE(UPPER(TRIM(color)), ' ', ''), '-', ''), '_', '')";

/** The article as Product Master names it, if it has an active size. */
function storedArticle(database: SqliteDatabase, article: string): string | null {
  const row = database.db
    .prepare("SELECT article FROM article_sizes WHERE UPPER(TRIM(article)) = UPPER(TRIM(?)) AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1")
    .get(article) as { article: string } | undefined;
  return row?.article ?? null;
}

/** The colour as the article already holds it on a live product, if it does. */
function heldColour(database: SqliteDatabase, article: string, color: string): string | null {
  const row = database.db
    .prepare(
      `SELECT color FROM product_variants WHERE UPPER(TRIM(article)) = UPPER(TRIM(?)) AND ${COMPACT_COLOUR_SQL} = ?
         AND deleted_at IS NULL AND COALESCE(status, 'ACTIVE') <> 'DISABLED' LIMIT 1`
    )
    .get(article, normalizeQrColor(color)) as { color: string } | undefined;
  return row?.color ?? null;
}

const alreadyAsked = (database: SqliteDatabase, article: string, color: string): boolean =>
  database.db
    .prepare(`SELECT 1 AS here FROM article_color_requests WHERE UPPER(TRIM(article)) = UPPER(TRIM(?)) AND ${COMPACT_COLOUR_SQL} = ? LIMIT 1`)
    .get(article, normalizeQrColor(color)) !== undefined;

/** Requests the Product Master computer has not dealt with yet, oldest first. */
const undealt = (database: SqliteDatabase): Array<{ id: string; article: string; color: string }> =>
  database.db
    .prepare(
      `SELECT r.id, r.article, r.color FROM article_color_requests r
        WHERE NOT EXISTS (SELECT 1 FROM article_color_request_results x WHERE x.request_id = r.id)
        ORDER BY r.created_at, r.id`
    )
    .all() as Array<{ id: string; article: string; color: string }>;

export const articleColorRequestMethods = {
  /** Asks the Product Master computer for a new colour on an article. Checked here as "+ New colour" checks it. */
  requestArticleColor(this: SqliteDatabase, input: { article: string; color: string; actor?: string | null }): ArticleColorRequestResult {
    const typed = String(input.article ?? "").trim();
    if (!typed) throw new CartonAdjustmentRefused("Choose the article first.");
    const color = cleanColourName(input.color);
    const article = storedArticle(this, typed);
    if (article === null) throw new CartonAdjustmentRefused(`${typed} has no active sizes in Product Master.`);
    const held = heldColour(this, article, color);
    if (held !== null) return { status: ARTICLE_COLOR_REQUEST_STATUS.ALREADY_THERE, color: held };
    if (!alreadyAsked(this, article, color)) {
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO article_color_requests (id, article, color, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), article, color, String(input.actor ?? "").trim() || null, now, now);
    }
    return { status: ARTICLE_COLOR_REQUEST_STATUS.REQUESTED, color };
  },

  /** On the Product Master computer only: adds every colour asked for and not yet dealt with. Returns how many. */
  applyArticleColorRequests(this: SqliteDatabase, now: string): number {
    if (!holdsProductMaster(this.db)) return 0;
    const note = this.db.prepare("INSERT INTO article_color_request_results (request_id, dealt_at, sizes_added, refusal) VALUES (?, ?, ?, ?)");
    let dealt = 0;
    for (const request of undealt(this)) {
      try {
        const result = this.addColorToArticle({ article: request.article, color: request.color });
        note.run(request.id, now, result.added, null);
      } catch (error) {
        // Refused in words (the article is gone): noted, never tried again. Anything else is tried at the next pull.
        if (!(error instanceof CartonAdjustmentRefused)) throw error;
        note.run(request.id, now, 0, error.message);
      }
      dealt += 1;
    }
    return dealt;
  },
};

export type ArticleColorRequestMethods = typeof articleColorRequestMethods;
