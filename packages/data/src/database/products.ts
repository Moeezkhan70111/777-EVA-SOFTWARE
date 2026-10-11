// Product master: ArticleSize + colour variants, groups, series, dropdown value lists.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance; bodies are unchanged from the original class.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { InventoryRow, PagedResult, ProductListEntry, ProductListKind, ProductListQuery, ProductVariantRecord, SaleableVariant } from "./types.js";
import { fromPaisa, fromPaisaOrNull, multiplyMoney, subtractMoney, toPaisaOrNull } from "@erp/domain";
import { IN_STORE_STOCK_SQL } from "./shared.js";

/**
 * The standard contractor rates of a product as they are stored: integer paisa, or null.
 *
 * Null is "not set" and is kept apart from 0 all the way down (migration 064): a product nobody
 * has priced shows as "Not priced" on a machine program, while an explicit 0 means that job is
 * not paid for this article. `undefined` in means null out — the form sends an empty box as
 * nothing, not as free work.
 */
const contractorRatesInPaisa = (input: {
  machineRate?: number | null;
  packingRate?: number | null;
  printingRate?: number | null;
}): { machineRatePaisa: number | null; packingRatePaisa: number | null; printingRatePaisa: number | null } => ({
  machineRatePaisa: toPaisaOrNull(input.machineRate),
  packingRatePaisa: toPaisaOrNull(input.packingRate),
  printingRatePaisa: toPaisaOrNull(input.printingRate),
});

/**
 * Whether a caller said anything about the contractor rates at all.
 *
 * NOT the same question as whether they are set: `null` means "clear it", and the full product
 * form sends null for a box left empty. Sending NOTHING means "leave them as they are", which is
 * what keeps a caller that knows nothing about contractor pricing — the older simple product
 * form, an import, anything added later — from silently blanking a rate somebody agreed.
 */
const mentionsContractorRates = (input: {
  machineRate?: number | null;
  packingRate?: number | null;
  printingRate?: number | null;
}): boolean => "machineRate" in input || "packingRate" in input || "printingRate" in input;

/** Writes only the three rate columns of one ArticleSize. Called only when they were given. */
const writeContractorRates = (
  db: SqliteDatabase,
  articleSizeId: string,
  input: { machineRate?: number | null; packingRate?: number | null; printingRate?: number | null },
  now: string
): void => {
  const rates = contractorRatesInPaisa(input);
  db.db
    .prepare(
      "UPDATE article_sizes SET machine_rate_paisa = ?, packing_rate_paisa = ?, printing_rate_paisa = ?, updated_at = ? WHERE id = ?"
    )
    .run(rates.machineRatePaisa, rates.packingRatePaisa, rates.printingRatePaisa, now, articleSizeId);
};

/** What an edited product is saved with. */
export interface ProductUpdateInput {
  article: string;
  /** Unused: colour variants are managed through `colors`. Kept optional for callers that still send it. */
  color?: string;
  size: string;
  description?: string;
  costPrice?: number;
  sellingPrice?: number;
  /** The standard contractor rates, per DOZEN, in rupees — see migration 064. */
  machineRate?: number | null;
  packingRate?: number | null;
  printingRate?: number | null;
  mainGroupId?: string;
  productGroupId?: string;
  articleSeriesId?: string;
  productTypeId?: string;
  productSubGroupId?: string;
  colors?: string[];
  status?: "ACTIVE" | "DISABLED";
}

/**
 * Renames ONE product's article and/or size — and its colour variants with it — when an edit
 * changed them. Must run inside the caller's transaction.
 *
 * The article and size ARE the product's identity: every carton QR spells them out
 * (SK6_BLACK_7/10_000001), so once a QR code carries them they can never change — the same rule
 * Product Lists applies to a whole article. Until then nothing points at the old name except this
 * product's own rows, which is why a rename is safe: a machine program refers to it by id, and
 * there is no stock, scan or sale without a QR code.
 *
 * An empty value means the caller did not send one (the simple product form), never "blank it".
 */
const renameArticleSize = (db: SqliteDatabase, articleSizeId: string, article: string, size: string, now: string): void => {
  const current = db.db.prepare("SELECT article, size FROM article_sizes WHERE id = ?").get(articleSizeId) as
    | { article: string; size: string }
    | undefined;
  if (!current) return;
  const nextArticle = article.trim().toUpperCase() || current.article;
  const nextSize = size.trim().toUpperCase() || current.size;
  if (nextArticle === current.article && nextSize === current.size) return;

  const qrCount = (db.db.prepare("SELECT COUNT(1) AS n FROM qr_codes WHERE article = ? AND size = ?").get(current.article, current.size) as { n: number }).n;
  if (qrCount > 0) {
    throw new Error(
      `${current.article} ${current.size} cannot be renamed: ${qrCount.toLocaleString()} QR ${qrCount === 1 ? "code carries" : "codes carry"} it in their identity. Create ${nextArticle} ${nextSize} as a new product instead.`
    );
  }
  // UNIQUE(article, size) and UNIQUE(article, color, size) count disabled rows too.
  const clash = db.db
    .prepare(
      `SELECT 1 FROM article_sizes WHERE article = ? AND size = ? AND id <> ?
       UNION SELECT 1 FROM product_variants WHERE article = ? AND size = ? AND COALESCE(article_size_id, '') <> ?
       LIMIT 1`
    )
    .get(nextArticle, nextSize, articleSizeId, nextArticle, nextSize, articleSizeId);
  if (clash) throw new Error(`${nextArticle} ${nextSize} already exists. Edit that product, or disable it first.`);

  db.db.prepare("UPDATE article_sizes SET article = ?, size = ?, updated_at = ? WHERE id = ?").run(nextArticle, nextSize, now, articleSizeId);
  db.db.prepare("UPDATE product_variants SET article = ?, size = ?, updated_at = ? WHERE article_size_id = ?").run(nextArticle, nextSize, now, articleSizeId);
};

const PRODUCT_LIST_TABLES: Record<
    "main-group" | "product-group" | "article-series" | "product-type" | "product-sub-group",
    { table: string; nameColumn: string; fk: string; label: string; discountTable: string | null; discountFk: string | null }
  > = {
  "main-group": { table: "main_groups", nameColumn: "group_name", fk: "main_group_id", label: "main group", discountTable: null, discountFk: null },
  "product-group": {
    table: "product_groups",
    nameColumn: "group_name",
    fk: "product_group_id",
    label: "product group",
    discountTable: "party_product_group_discounts",
    discountFk: "product_group_id",
  },
  "article-series": {
    table: "article_series",
    nameColumn: "name",
    fk: "article_series_id",
    label: "article series",
    discountTable: "party_article_series_discounts",
    discountFk: "article_series_id",
  },
  // Added 2026-10-11. Neither carries party discounts, so both read like the main group.
  "product-type": { table: "product_types", nameColumn: "name", fk: "product_type_id", label: "product type", discountTable: null, discountFk: null },
  "product-sub-group": {
    table: "product_sub_groups",
    nameColumn: "name",
    fk: "product_sub_group_id",
    label: "product sub group",
    discountTable: null,
    discountFk: null,
  },
};

export const productsMethods = {
  listProducts(this: SqliteDatabase, query: ProductListQuery = {}): PagedResult<ProductVariantRecord> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const where: string[] = [];
    const values: Array<string | number> = [];

    if (query.status && query.status !== "ALL") {
      if (query.status === "DISABLED") {
        // Disabled products have deleted_at set — include them, exclude active ones
        where.push("ass.deleted_at IS NOT NULL");
        where.push("ass.status = 'DISABLED'");
      } else {
        // ACTIVE: only non-deleted rows
        where.push("ass.deleted_at IS NULL");
        where.push("ass.status = ?");
        values.push(query.status);
      }
    } else {
      // ALL — show everything (active and disabled), no deleted_at filter
      // "deleted_at" is set on disable but does not mean permanently removed
    }

    if (query.search?.trim()) {
      where.push("(ass.article LIKE ? OR pv.color LIKE ? OR ass.size LIKE ? OR COALESCE(ass.description, '') LIKE ?)");
      const needle = `%${query.search.trim()}%`;
      values.push(needle, needle, needle, needle);
    }

    const whereClause = where.length > 0 ? where.join(" AND ") : "1=1";

    // Drive the listing from article_sizes so newly created products show up
    // immediately even before any colored variant has been created for them.
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) as c FROM (
           SELECT DISTINCT ass.id
           FROM article_sizes ass
           LEFT JOIN product_variants pv ON pv.article_size_id = ass.id AND pv.deleted_at IS NULL
           WHERE ${whereClause}
         )`
      )
      .get(...values) as { c: number };

    const rows = this.db
      .prepare(
        `SELECT
                ass.id as article_size_id, ass.product_code,
                ass.article,
                ass.size,
                ass.description,
                ass.cost_price_paisa,
                ass.selling_price_paisa,
                ass.main_group_id,
                ass.product_group_id,
                ass.article_series_id,
                ass.product_type_id,
                ass.product_sub_group_id,
                ass.status,
                ass.created_at,
                ass.updated_at,
                group_concat(DISTINCT pv.color) as colors,
                mg.group_name as main_group_name,
                pg.group_name as product_group_name,
                aseries.name as article_series_name
         FROM article_sizes ass
         LEFT JOIN product_variants pv ON pv.article_size_id = ass.id AND pv.deleted_at IS NULL
         LEFT JOIN main_groups mg ON mg.id = ass.main_group_id
         LEFT JOIN product_groups pg ON pg.id = ass.product_group_id
         LEFT JOIN article_series aseries ON aseries.id = ass.article_series_id
         WHERE ${whereClause}
         GROUP BY ass.id
         ORDER BY ass.updated_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...values, pageSize, offset) as Array<Record<string, unknown>>;

    return {
      rows: rows.map((row) => ({
        id: String(row.article_size_id ?? ""),
        articleSizeId: String(row.article_size_id ?? ""),
        productCode: row.product_code ? String(row.product_code) : null,
        article: String(row.article ?? ""),
        color: "",
        size: String(row.size ?? ""),
        colors: row.colors ? String(row.colors).split(",").filter(Boolean) : [],
        description: row.description ? String(row.description) : null,
        costPrice: fromPaisaOrNull(row.cost_price_paisa == null ? null : Number(row.cost_price_paisa)),
        sellingPrice: fromPaisaOrNull(row.selling_price_paisa == null ? null : Number(row.selling_price_paisa)),
        mainGroupId: row.main_group_id ? String(row.main_group_id) : null,
        groupId: row.product_group_id ? String(row.product_group_id) : null,
        articleSeriesId: row.article_series_id ? String(row.article_series_id) : null,
      productTypeId: row.product_type_id ? String(row.product_type_id) : null,
      productSubGroupId: row.product_sub_group_id ? String(row.product_sub_group_id) : null,
        articleSeriesName: row.article_series_name ? String(row.article_series_name) : null,
        mainGroupName: row.main_group_name ? String(row.main_group_name) : null,
        groupName: row.product_group_name ? String(row.product_group_name) : null,
        status: String(row.status ?? "ACTIVE"),
        createdAt: String(row.created_at ?? ""),
        updatedAt: String(row.updated_at ?? ""),
      })),
      total: totalRow.c,
      page,
      pageSize,
    };
  },

  getProduct(this: SqliteDatabase, id: string): ProductVariantRecord | null {
    const row = this.db
      .prepare(
          `SELECT
            ass.id as article_size_id, ass.product_code,
            ass.article,
            ass.size,
            ass.description,
            ass.cost_price_paisa,
            ass.selling_price_paisa,
            ass.machine_rate_paisa,
            ass.packing_rate_paisa,
            ass.printing_rate_paisa,
            ass.main_group_id,
            ass.product_group_id,
            ass.article_series_id,
            ass.product_type_id,
            ass.product_sub_group_id,
            ass.status,
            ass.created_at,
            ass.updated_at,
            group_concat(DISTINCT pv.color) as colors,
           mg.group_name as main_group_name,
           pg.group_name as product_group_name,
           aseries.name as article_series_name
         FROM article_sizes ass
          LEFT JOIN product_variants pv ON pv.article_size_id = ass.id AND pv.deleted_at IS NULL
          LEFT JOIN main_groups mg ON mg.id = ass.main_group_id
          LEFT JOIN product_groups pg ON pg.id = ass.product_group_id
          LEFT JOIN article_series aseries ON aseries.id = ass.article_series_id
          WHERE ass.id = ? OR pv.id = ?
          GROUP BY ass.id`
      )
        .get(id, id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: String(row.article_size_id ?? ""),
      articleSizeId: String(row.article_size_id ?? ""),
        productCode: row.product_code ? String(row.product_code) : null,
      article: String(row.article ?? ""),
      color: "",
      size: String(row.size ?? ""),
      colors: row.colors ? String(row.colors).split(",").filter(Boolean) : [],
      description: row.description ? String(row.description) : null,
      costPrice: fromPaisaOrNull(row.cost_price_paisa == null ? null : Number(row.cost_price_paisa)),
      sellingPrice: fromPaisaOrNull(row.selling_price_paisa == null ? null : Number(row.selling_price_paisa)),
      // The product's STANDARD contractor rates, per DOZEN, in paisa. Null is "not set", which
      // every reader keeps apart from a rate of 0 (that job is not paid for this article).
      machineRatePaisa: row.machine_rate_paisa == null ? null : Number(row.machine_rate_paisa),
      packingRatePaisa: row.packing_rate_paisa == null ? null : Number(row.packing_rate_paisa),
      printingRatePaisa: row.printing_rate_paisa == null ? null : Number(row.printing_rate_paisa),
      mainGroupId: row.main_group_id ? String(row.main_group_id) : null,
      groupId: row.product_group_id ? String(row.product_group_id) : null,
      articleSeriesId: row.article_series_id ? String(row.article_series_id) : null,
      productTypeId: row.product_type_id ? String(row.product_type_id) : null,
      productSubGroupId: row.product_sub_group_id ? String(row.product_sub_group_id) : null,
      articleSeriesName: row.article_series_name ? String(row.article_series_name) : null,
      mainGroupName: row.main_group_name ? String(row.main_group_name) : null,
      groupName: row.product_group_name ? String(row.product_group_name) : null,
      status: String(row.status ?? "ACTIVE"),
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
    };
  },

  getSaleableVariant(this: SqliteDatabase, id: string): SaleableVariant | null {
    const row = this.db
      .prepare(
        `SELECT
           pv.id,
           pv.article,
           pv.size,
           pv.color,
           ass.id as article_size_id, ass.product_code,
           ass.selling_price_paisa,
           ass.article_series_id,
           ass.product_type_id,
           ass.product_sub_group_id,
           ass.product_group_id,
           ${IN_STORE_STOCK_SQL} AS stock_quantity
         FROM product_variants pv
         JOIN article_sizes ass ON ass.id = pv.article_size_id
         WHERE pv.id = ? AND pv.deleted_at IS NULL AND pv.status = 'ACTIVE' AND ass.deleted_at IS NULL AND ass.status = 'ACTIVE'`
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: String(row.id ?? ""),
      articleSizeId: row.article_size_id ? String(row.article_size_id) : null,
      article: String(row.article ?? ""),
      size: String(row.size ?? ""),
      color: String(row.color ?? ""),
      sellingPrice: fromPaisaOrNull(row.selling_price_paisa == null ? null : Number(row.selling_price_paisa)),
      stockQuantity: Number(row.stock_quantity ?? 0),
      articleSeriesId: row.article_series_id ? String(row.article_series_id) : null,
      productGroupId: row.product_group_id ? String(row.product_group_id) : null,
    };
  },

  getOrCreateArticleSize(this: SqliteDatabase, input: {
    article: string;
    size: string;
    description?: string;
    costPrice?: number;
    sellingPrice?: number;
    /** The standard contractor rates, per DOZEN, in rupees. Undefined leaves them untouched. */
    machineRate?: number | null;
    packingRate?: number | null;
    printingRate?: number | null;
    mainGroupId?: string;
    productGroupId?: string;
    articleSeriesId?: string;
    productTypeId?: string;
    productSubGroupId?: string;
    updateExisting?: boolean;
    productCode?: string;
    status?: "ACTIVE" | "DISABLED";
  }): string {
    const article = input.article.trim().toUpperCase();
    const size = input.size.trim();
    const costPricePaisa = toPaisaOrNull(input.costPrice);
    const sellingPricePaisa = toPaisaOrNull(input.sellingPrice);
    const rates = contractorRatesInPaisa(input);
    // Deliberately NOT filtered on deleted_at.
    //
    // Deleting a product is a SOFT delete (disableProduct sets status = 'DISABLED' and
    // deleted_at), but the schema's UNIQUE(article, size) is a hard constraint that knows
    // nothing about deleted_at. Filtering the lookup to live rows therefore used to miss the
    // very row holding the slot, fall through to the INSERT below, and die on the constraint —
    // "Error processing product" when an operator deleted a product and made it again.
    //
    // So a deleted row is found and REVIVED: making SK9 7/10 again gives back SK9 7/10, keeping
    // its id and its product code, which is what every QR, stock row and voucher line already
    // pointing at that id requires. Its colour variants are left as they are — re-enabling the
    // product is what brings those back (enableProduct), while creating it again only promises
    // the product itself, with whatever colours this call names.
    const existing = this.db
      .prepare("SELECT id, deleted_at FROM article_sizes WHERE article = ? AND size = ? LIMIT 1")
      .get(article, size) as { id: string; deleted_at: string | null } | undefined;
    if (existing) {
      const now = new Date().toISOString();
      if (input.updateExisting) {
        this.db.prepare(`UPDATE article_sizes SET description = ?, cost_price_paisa = ?, selling_price_paisa = ?, main_group_id = ?, product_group_id = ?, article_series_id = ?, product_type_id = ?, product_sub_group_id = ?, status = ?, updated_at = ? WHERE id = ?`)
          .run(input.description ?? null, costPricePaisa, sellingPricePaisa, input.mainGroupId ?? null, input.productGroupId ?? null, input.articleSeriesId ?? null, input.productTypeId ?? null, input.productSubGroupId ?? null, input.status ?? "ACTIVE", now, existing.id);
        // Only when the caller said something about them — see mentionsContractorRates.
        if (mentionsContractorRates(input)) writeContractorRates(this, existing.id, input, now);
      }
      // Bringing it back is its own step, so a caller that asked not to overwrite the row's
      // figures still gets a product it can actually use.
      if (existing.deleted_at) {
        this.db.prepare(`UPDATE article_sizes SET status = ?, deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, updated_at = ? WHERE id = ?`)
          .run(input.status ?? "ACTIVE", now, existing.id);
      }
      return existing.id;
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO article_sizes (id, product_code, article, size, description, cost_price_paisa, selling_price_paisa, machine_rate_paisa, packing_rate_paisa, printing_rate_paisa, main_group_id, product_group_id, article_series_id, product_type_id, product_sub_group_id, status, created_at, updated_at, deleted_at, deleted_by, delete_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`)
      .run(id, input.productCode ?? this.getNextProductCode(), article, size, input.description ?? null, costPricePaisa, sellingPricePaisa, rates.machineRatePaisa, rates.packingRatePaisa, rates.printingRatePaisa, input.mainGroupId ?? null, input.productGroupId ?? null, input.articleSeriesId ?? null, input.productTypeId ?? null, input.productSubGroupId ?? null, input.status ?? "ACTIVE", now, now);
    return id;
  },

  createProduct(this: SqliteDatabase, input: {
    article: string;
    color?: string;
    size: string;
    description?: string;
    costPrice?: number;
    sellingPrice?: number;
    /** The standard contractor rates, per DOZEN, in rupees — see migration 064. */
    machineRate?: number | null;
    packingRate?: number | null;
    printingRate?: number | null;
    mainGroupId?: string;
    productGroupId?: string;
    articleSeriesId?: string;
    productTypeId?: string;
    productSubGroupId?: string;
    colors?: string[];
    status?: "ACTIVE" | "DISABLED";
    productCode?: string;
  }): string {
    const now = new Date().toISOString();
    const articleSizeId = this.getOrCreateArticleSize({ ...input, updateExisting: true });
    const costPricePaisa = toPaisaOrNull(input.costPrice);
    const sellingPricePaisa = toPaisaOrNull(input.sellingPrice);
    const colors = (input.colors ?? (input.color ? [input.color] : [])).map((color) => color.trim().toUpperCase()).filter((color) => color && color !== "N/A" && color !== "NULL" && color !== "UNDEFINED");
    let firstId = articleSizeId;
    for (const color of [...new Set(colors)]) {
      const id = this.upsertProductVariant({
        articleSizeId,
        article: input.article.trim().toUpperCase(),
        color,
        size: input.size.trim(),
        description: input.description ?? null,
        costPricePaisa,
        sellingPricePaisa,
        mainGroupId: input.mainGroupId ?? null,
        productGroupId: input.productGroupId ?? null,
        articleSeriesId: input.articleSeriesId ?? null,
        productTypeId: input.productTypeId ?? null,
        productSubGroupId: input.productSubGroupId ?? null,
        status: input.status ?? "ACTIVE",
        now,
      });
      if (firstId === articleSizeId) firstId = id;
    }
    // Existing variants keep independent copies of these fields (read by sale/discount/report queries), so keep them in sync.
    this.db.prepare(`UPDATE product_variants SET description = ?, cost_price_paisa = ?, selling_price_paisa = ?, main_group_id = ?, product_group_id = ?, article_series_id = ?, product_type_id = ?, product_sub_group_id = ?, updated_at = ? WHERE article_size_id = ? AND deleted_at IS NULL`)
      .run(input.description ?? null, costPricePaisa, sellingPricePaisa, input.mainGroupId ?? null, input.productGroupId ?? null, input.articleSeriesId ?? null, input.productTypeId ?? null, input.productSubGroupId ?? null, now, articleSizeId);
    return firstId;
  },

  /**
   * Resolves the colour-specific identity for a Product Master entry.
   *
   * `product_variants` is the canonical colour identity in this schema (UNIQUE(article, color, size),
   * and the row every scan, stock projection and voucher line points at), so registering a colour is
   * exactly "make sure the variant exists". This creates at most ONE variant per combination no matter
   * how many QR codes are generated, and never touches `article_sizes` — generating QR codes can never
   * create a Product Master product.
   */
  resolveVariantForColor(this: SqliteDatabase, 
    product: { id: string; article: string; size: string },
    color: string,
    now: string
  ): string {
    const normalizedMatch =
      "UPPER(REPLACE(REPLACE(REPLACE(color, ' ', ''), '-', ''), '_', '')) = ?";

    // Match on the normalised colour so red / Red / RED / "Red " all land on one variant.
    const existing = this.db
      .prepare(
        `SELECT id, deleted_at FROM product_variants
         WHERE article = ? AND size = ? AND ${normalizedMatch}
         ORDER BY deleted_at IS NOT NULL, created_at
         LIMIT 1`
      )
      .get(product.article, product.size, color) as { id: string; deleted_at: string | null } | undefined;

    if (existing) {
      if (existing.deleted_at) {
        throw new Error(
          `${product.article} / ${color} / ${product.size} is disabled in Product Master. Re-enable the product before generating QR codes.`
        );
      }
      // Older variants may predate the article_sizes link; attach them without altering anything else.
      this.db
        .prepare("UPDATE product_variants SET article_size_id = ?, updated_at = ? WHERE id = ? AND article_size_id IS NULL")
        .run(product.id, now, existing.id);
      return existing.id;
    }

    // New colour: inherit the product facts that sale/discount/report queries read off the variant.
    const master = this.db
      .prepare(
        `SELECT description, cost_price_paisa, selling_price_paisa,
                main_group_id, product_group_id, article_series_id
         FROM article_sizes WHERE id = ?`
      )
      .get(product.id) as Record<string, unknown> | undefined;

    const variantId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO product_variants (
           id, article, color, size, description,
           cost_price_paisa, selling_price_paisa,
           main_group_id, product_group_id, article_series_id, article_size_id,
           status, created_at, updated_at, deleted_at, deleted_by, delete_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, NULL, NULL, NULL)`
      )
      .run(
        variantId,
        product.article,
        color,
        product.size,
        (master?.description as string | null) ?? null,
        (master?.cost_price_paisa as number | null) ?? null,
        (master?.selling_price_paisa as number | null) ?? null,
        (master?.main_group_id as string | null) ?? null,
        (master?.product_group_id as string | null) ?? null,
        (master?.article_series_id as string | null) ?? null,
        product.id,
        now,
        now
      );
    return variantId;
  },

<<<<<<< HEAD
  /**
   * Saves an edited product. A changed ARTICLE or SIZE renames this one product (and its colour
   * variants) while no QR code carries it — see renameArticleSize.
   */
  updateProduct(this: SqliteDatabase, id: string, input: ProductUpdateInput): void {
    // All of it or none of it: a rename that went through with the prices refused (or the other
    // way round) would leave a product nobody asked for.
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const articleSizeId = this.getProduct(id)?.articleSizeId ?? id;
      renameArticleSize(this, articleSizeId, input.article, input.size, new Date().toISOString());
      this.applyProductUpdate(articleSizeId, input);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no transaction to roll back */ }
      throw error;
=======
  updateProduct(this: SqliteDatabase, 
    id: string,
    input: {
      article: string;
      /** Unused: colour variants are managed through `colors`. Kept optional for callers that still send it. */
      color?: string;
      size: string;
      description?: string;
      costPrice?: number;
      sellingPrice?: number;
      /** The standard contractor rates, per DOZEN, in rupees — see migration 064. */
      machineRate?: number | null;
      packingRate?: number | null;
      printingRate?: number | null;
      mainGroupId?: string;
      productGroupId?: string;
      articleSeriesId?: string;
      productTypeId?: string;
      productSubGroupId?: string;
      colors?: string[];
      status?: "ACTIVE" | "DISABLED";
>>>>>>> 3269f98a641b7a34ca7c94a185e4a1e67738de8f
    }
  },

  /** @internal The body of updateProduct, inside its transaction. */
  applyProductUpdate(this: SqliteDatabase, articleSizeId: string, input: ProductUpdateInput): void {
    const now = new Date().toISOString();
    const costPricePaisa = toPaisaOrNull(input.costPrice);
    const sellingPricePaisa = toPaisaOrNull(input.sellingPrice);
    // The contractor rates live ONLY on the ArticleSize: a carton's colour has no bearing on what
    // moulding a dozen is paid, so unlike the prices below there is nothing to copy onto the
    // colour variants and nothing that can fall out of sync.
    this.db.prepare(`UPDATE article_sizes SET description = ?, cost_price_paisa = ?, selling_price_paisa = ?, main_group_id = ?, product_group_id = ?, article_series_id = ?, product_type_id = ?, product_sub_group_id = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(input.description ?? null, costPricePaisa, sellingPricePaisa, input.mainGroupId ?? null, input.productGroupId ?? null, input.articleSeriesId ?? null, input.productTypeId ?? null, input.productSubGroupId ?? null, input.status ?? "ACTIVE", now, articleSizeId);
    // The rates are written only when this save was about them. A form that knows nothing about
    // contractor pricing (the simple one on ProductsPage) must not blank an agreed rate.
    if (mentionsContractorRates(input)) writeContractorRates(this, articleSizeId, input, now);
    // Existing variants keep independent copies of these fields (read by sale/discount/report queries), so keep them in sync.
    this.db.prepare(`UPDATE product_variants SET description = ?, cost_price_paisa = ?, selling_price_paisa = ?, main_group_id = ?, product_group_id = ?, article_series_id = ?, product_type_id = ?, product_sub_group_id = ?, status = ?, updated_at = ? WHERE article_size_id = ? AND deleted_at IS NULL`)
      .run(input.description ?? null, costPricePaisa, sellingPricePaisa, input.mainGroupId ?? null, input.productGroupId ?? null, input.articleSeriesId ?? null, input.productTypeId ?? null, input.productSubGroupId ?? null, input.status ?? "ACTIVE", now, articleSizeId);
    const existing = this.db.prepare("SELECT article, size FROM article_sizes WHERE id = ?").get(articleSizeId) as { article: string; size: string } | undefined;
    if (!existing) return;
    for (const color of (input.colors ?? []).map((value) => value.trim().toUpperCase()).filter((value) => value && value !== "N/A" && value !== "NULL" && value !== "UNDEFINED")) {
      this.upsertProductVariant({
        articleSizeId,
        article: existing.article,
        color,
        size: existing.size,
        description: input.description ?? null,
        costPricePaisa,
        sellingPricePaisa,
        mainGroupId: input.mainGroupId ?? null,
        productGroupId: input.productGroupId ?? null,
        articleSeriesId: input.articleSeriesId ?? null,
        productTypeId: input.productTypeId ?? null,
        productSubGroupId: input.productSubGroupId ?? null,
        status: input.status ?? "ACTIVE",
        now,
      });
    }
  },

  /**
   * @internal Makes sure one colour variant of a product exists, and returns its id.
   *
   * The colour counterpart of the lookup in getOrCreateArticleSize, and for the same reason:
   * `product_variants` has a hard UNIQUE(article, color, size) while deleting a colour only sets
   * deleted_at. A lookup narrowed to live rows misses the row holding the slot and the INSERT
   * dies on the constraint, so the match deliberately ignores deleted_at and a deleted colour is
   * brought back rather than duplicated — keeping its id, which its QR codes and stock point at.
   *
   * One place, because createProduct and updateProduct must never disagree about what
   * "this colour exists" means.
   */
  upsertProductVariant(this: SqliteDatabase, input: {
    articleSizeId: string;
    article: string;
    color: string;
    size: string;
    description: string | null;
    costPricePaisa: number | null;
    sellingPricePaisa: number | null;
    mainGroupId: string | null;
    productGroupId: string | null;
    articleSeriesId: string | null;
    productTypeId: string | null;
    productSubGroupId: string | null;
    status: "ACTIVE" | "DISABLED";
    now: string;
  }): string {
    const existing = this.db
      .prepare("SELECT id, deleted_at FROM product_variants WHERE article = ? AND color = ? AND size = ? LIMIT 1")
      .get(input.article, input.color, input.size) as { id: string; deleted_at: string | null } | undefined;

    if (existing) {
      // An older variant may predate the article_sizes link, so it is attached here too.
      this.db
        .prepare(
          `UPDATE product_variants SET article_size_id = COALESCE(article_size_id, ?), status = ?,
             deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(input.articleSizeId, input.status, input.now, existing.id);
      return existing.id;
    }

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO product_variants (id, article, color, size, description, cost_price_paisa, selling_price_paisa, main_group_id, product_group_id, article_series_id, product_type_id, product_sub_group_id, article_size_id, status, created_at, updated_at, deleted_at, deleted_by, delete_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
      )
      .run(
        id, input.article, input.color, input.size, input.description, input.costPricePaisa, input.sellingPricePaisa,
        input.mainGroupId, input.productGroupId, input.articleSeriesId, input.productTypeId, input.productSubGroupId, input.articleSizeId, input.status, input.now, input.now
      );
    return id;
  },

  disableProduct(this: SqliteDatabase, id: string, reason = "Disabled from product management"): void {
    const now = new Date().toISOString();
    const articleSize = this.db.prepare("SELECT id FROM article_sizes WHERE id = ? LIMIT 1").get(id) as { id: string } | undefined;
    if (articleSize) {
      this.db.prepare("UPDATE article_sizes SET status = 'DISABLED', deleted_at = ?, delete_reason = ?, updated_at = ? WHERE id = ?").run(now, reason, now, id);
      this.db.prepare("UPDATE product_variants SET status = 'DISABLED', deleted_at = ?, delete_reason = ?, updated_at = ? WHERE article_size_id = ?").run(now, reason, now, id);
      return;
    }
    this.db.prepare("UPDATE product_variants SET status = 'DISABLED', deleted_at = ?, delete_reason = ?, updated_at = ? WHERE id = ?").run(now, reason, now, id);
  },

  enableProduct(this: SqliteDatabase, id: string): void {
    const now = new Date().toISOString();
    const articleSize = this.db.prepare("SELECT id FROM article_sizes WHERE id = ? LIMIT 1").get(id) as { id: string } | undefined;
    if (articleSize) {
      this.db.prepare("UPDATE article_sizes SET status = 'ACTIVE', deleted_at = NULL, delete_reason = NULL, updated_at = ? WHERE id = ?").run(now, id);
      this.db.prepare("UPDATE product_variants SET status = 'ACTIVE', deleted_at = NULL, delete_reason = NULL, updated_at = ? WHERE article_size_id = ?").run(now, id);
      return;
    }
    this.db.prepare("UPDATE product_variants SET status = 'ACTIVE', deleted_at = NULL, delete_reason = NULL, updated_at = ? WHERE id = ?").run(now, id);
  },

  listInventory(this: SqliteDatabase, search = ""): InventoryRow[] {
    const needle = `%${search.trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT
           pv.id,
           ass.id as article_size_id, ass.product_code,
           pv.article,
           pv.color,
           pv.size,
           ${IN_STORE_STOCK_SQL} as quantity,
           COALESCE((SELECT SUM(spl.quantity_on_hand) FROM stock_projection_by_location spl
                     WHERE spl.product_variant_id = pv.id AND spl.location_type = 'FACTORY'), 0) as production_quantity,
           ${IN_STORE_STOCK_SQL} as store_quantity,
           COALESCE((SELECT SUM(spl.quantity_on_hand) FROM stock_projection_by_location spl
                     WHERE spl.product_variant_id = pv.id AND spl.location_type = 'GATE'), 0) as gate_quantity,
           COALESCE(ass.cost_price_paisa, 0) as cost_price_paisa,
           COALESCE(ass.selling_price_paisa, 0) as selling_price_paisa
         FROM product_variants pv
         JOIN article_sizes ass ON ass.id = pv.article_size_id
         WHERE pv.status != 'DISABLED'
           AND pv.deleted_at IS NULL
           AND ass.deleted_at IS NULL
           AND (? = '%%' OR pv.article LIKE ? OR pv.color LIKE ? OR pv.size LIKE ?)
         ORDER BY quantity DESC, pv.article ASC`
      )
      .all(needle, needle, needle, needle) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const quantity = Number(row.quantity ?? 0);
      const cost = fromPaisa(Number(row.cost_price_paisa ?? 0));
      const selling = fromPaisa(Number(row.selling_price_paisa ?? 0));
      return {
        productId: String(row.id ?? ""),
        articleSizeId: row.article_size_id ? String(row.article_size_id) : null,
        article: String(row.article ?? ""),
        color: String(row.color ?? ""),
        size: String(row.size ?? ""),
        quantity,
        productionQuantity: Number(row.production_quantity ?? 0),
        storeQuantity: Number(row.store_quantity ?? 0),
        gateQuantity: Number(row.gate_quantity ?? 0),
        costPrice: cost,
        sellingPrice: selling,
        stockValue: multiplyMoney(cost, quantity),
        potentialRevenue: multiplyMoney(selling, quantity),
        profitPotential: subtractMoney(multiplyMoney(selling, quantity), multiplyMoney(cost, quantity)),
      };
    });
  },

  createProductGroup(this: SqliteDatabase, input: { groupName: string; description?: string }): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO product_groups (id, group_name, description, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`
      )
      .run(id, input.groupName.trim(), input.description || null, now, now);

    return id;
  },

  listProductGroups(this: SqliteDatabase): Array<{ id: string; groupName: string; description?: string; isActive: boolean }> {
    const rows = this.db
      .prepare(`SELECT id, group_name, description, is_active FROM product_groups WHERE deleted_at IS NULL ORDER BY group_name ASC`)
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      groupName: String(row.group_name ?? ""),
      description: row.description ? String(row.description) : undefined,
      isActive: Boolean(row.is_active),
    }));
  },

  getProductGroupByName(this: SqliteDatabase, groupName: string): { id: string; groupName: string } | null {
    const row = this.db
      .prepare(`SELECT id, group_name FROM product_groups WHERE group_name = ? AND deleted_at IS NULL LIMIT 1`)
      .get(groupName.trim()) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: String(row.id ?? ""),
      groupName: String(row.group_name ?? ""),
    };
  },

  createMainGroup(this: SqliteDatabase, input: { groupName: string; description?: string }): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO main_groups (id, group_name, description, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`
      )
      .run(id, input.groupName.trim(), input.description || null, now, now);

    return id;
  },

  listMainGroups(this: SqliteDatabase): Array<{ id: string; groupName: string; description?: string; isActive: boolean }> {
    const rows = this.db
      .prepare(`SELECT id, group_name, description, is_active FROM main_groups WHERE deleted_at IS NULL ORDER BY group_name ASC`)
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      groupName: String(row.group_name ?? ""),
      description: row.description ? String(row.description) : undefined,
      isActive: Boolean(row.is_active),
    }));
  },

  getMainGroupByName(this: SqliteDatabase, groupName: string): { id: string; groupName: string } | null {
    const row = this.db
      .prepare(`SELECT id, group_name FROM main_groups WHERE group_name = ? AND deleted_at IS NULL LIMIT 1`)
      .get(groupName.trim()) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: String(row.id ?? ""),
      groupName: String(row.group_name ?? ""),
    };
  },

  createArticleSeries(this: SqliteDatabase, input: { name: string; description?: string }): string {
    const trimmed = input.name.trim();
    if (!trimmed) throw new Error("Article series name is required");

    const normalized = trimmed.toUpperCase();
    const existing = this.db
      .prepare(`SELECT id FROM article_series WHERE UPPER(name) = ? AND deleted_at IS NULL LIMIT 1`)
      .get(normalized) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO article_series (id, name, description, is_active, created_at, updated_at, deleted_at, deleted_by, delete_reason)
         VALUES (?, ?, ?, 1, ?, ?, NULL, NULL, NULL)`
      )
      .run(id, trimmed, input.description ?? null, now, now);
    return id;
  },

  listArticleSeries(this: SqliteDatabase): Array<{ id: string; name: string; description?: string | null; isActive: boolean }> {
    const rows = this.db
      .prepare(`SELECT id, name, description, is_active FROM article_series WHERE deleted_at IS NULL ORDER BY name ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      name: String(row.name ?? ""),
      description: row.description ? String(row.description) : null,
      isActive: Number(row.is_active ?? 0) === 1,
    }));
  },

  getArticleSeriesByName(this: SqliteDatabase, name: string): { id: string; name: string } | null {
    const normalized = name.trim();
    const row = this.db
      .prepare(`SELECT id, name FROM article_series WHERE UPPER(name) = UPPER(?) AND deleted_at IS NULL LIMIT 1`)
      .get(normalized) as { id: string; name: string } | undefined;
    if (!row) return null;
    return { id: row.id, name: row.name };
  },

  /* ── Product Lists (manage the Add / Edit Product dropdown values) ───────────── */
  // Groups and series are their own tables and are renamed in place or soft-deleted.
  // Articles and sizes only exist as parts of Product Master entries (article_sizes /
  // product_variants), so renaming one rewrites every product carrying it and deleting
  // one disables those products — never while a registered QR code embeds the value,
  // because the code identity (SK6_RED_7/10_000001) would no longer match a product.


  isValueList(this: SqliteDatabase, kind: ProductListKind): kind is "article" | "size" {
    return kind === "article" || kind === "size";
  },

  listProductListEntries(this: SqliteDatabase, kind: ProductListKind): ProductListEntry[] {
    if (this.isValueList(kind)) {
      const column = kind === "article" ? "article" : "size";
      const rows = this.db
        .prepare(
          `SELECT a.${column} AS name,
                  SUM(CASE WHEN a.deleted_at IS NULL AND a.status = 'ACTIVE' THEN 1 ELSE 0 END) AS product_count,
                  SUM(CASE WHEN a.deleted_at IS NOT NULL OR a.status <> 'ACTIVE' THEN 1 ELSE 0 END) AS disabled_count,
                  (SELECT COUNT(1) FROM qr_codes b WHERE b.${column} = a.${column}) AS qr_count
           FROM article_sizes a
           GROUP BY a.${column}
           HAVING product_count > 0
           ORDER BY a.${column} ASC`
        )
        .all() as Array<Record<string, unknown>>;
      return rows.map((row) => {
        const qrCount = Number(row.qr_count ?? 0);
        const blocked =
          qrCount > 0
            ? `${qrCount.toLocaleString()} QR ${qrCount === 1 ? "code carries" : "codes carry"} this ${kind} in its identity, so it cannot be changed. Create the correct product instead.`
            : null;
        return {
          kind,
          id: String(row.name),
          name: String(row.name),
          productCount: Number(row.product_count ?? 0),
          disabledProductCount: Number(row.disabled_count ?? 0),
          qrCount,
          discountRuleCount: 0,
          renameBlockedReason: blocked,
          deleteBlockedReason: blocked,
        };
      });
    }

    const meta = PRODUCT_LIST_TABLES[kind];
    // A product sub group is unique only WITHIN its product group — "CASUAL" can be under
    // GENTS and under LADIES — so the list says which group each one belongs to.
    const parentSql =
      kind === "product-sub-group"
        ? "(SELECT pg.group_name FROM product_groups pg WHERE pg.id = g.product_group_id)"
        : "NULL";
    const discountSql = meta.discountTable
      ? `(SELECT COUNT(1) FROM ${meta.discountTable} d WHERE d.${meta.discountFk} = g.id AND d.deleted_at IS NULL)`
      : "0";
    const rows = this.db
      .prepare(
        `SELECT g.id, g.${meta.nameColumn} AS name, ${parentSql} AS parent_name,
                (SELECT COUNT(1) FROM article_sizes a WHERE a.${meta.fk} = g.id AND a.deleted_at IS NULL AND a.status = 'ACTIVE')
                + (SELECT COUNT(1) FROM product_variants v WHERE v.${meta.fk} = g.id AND v.deleted_at IS NULL AND v.article_size_id IS NULL) AS product_count,
                (SELECT COUNT(1) FROM article_sizes a WHERE a.${meta.fk} = g.id AND (a.deleted_at IS NOT NULL OR a.status <> 'ACTIVE')) AS disabled_count,
                ${discountSql} AS discount_count
         FROM ${meta.table} g
         WHERE g.deleted_at IS NULL
         ORDER BY g.${meta.nameColumn} COLLATE NOCASE ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const productCount = Number(row.product_count ?? 0);
      const discountRuleCount = Number(row.discount_count ?? 0);
      const reasons: string[] = [];
      if (productCount > 0) reasons.push(`used by ${productCount.toLocaleString()} ${productCount === 1 ? "product" : "products"}`);
      if (discountRuleCount > 0) reasons.push(`used by ${discountRuleCount.toLocaleString()} party discount ${discountRuleCount === 1 ? "rule" : "rules"}`);
      return {
        kind,
        id: String(row.id),
        name: String(row.name),
        parentName: row.parent_name ? String(row.parent_name) : null,
        productCount,
        disabledProductCount: Number(row.disabled_count ?? 0),
        qrCount: 0,
        discountRuleCount,
        renameBlockedReason: null,
        deleteBlockedReason: reasons.length ? `Still ${reasons.join(" and ")}. Move them to another ${meta.label} first.` : null,
      };
    });
  },

  /** Renames one dropdown value everywhere it is used. Returns how many rows changed. */
  renameProductListEntry(this: SqliteDatabase, input: { kind: ProductListKind; id: string; newName: string }): { affected: number; name: string } {
    const kind = input.kind;
    const newName = String(input.newName ?? "").trim().toUpperCase();
    if (!newName) throw new Error("A name is required.");
    const now = new Date().toISOString();

    if (this.isValueList(kind)) {
      const column = kind === "article" ? "article" : "size";
      const other = kind === "article" ? "size" : "article";
      const oldName = String(input.id ?? "").trim();
      if (!oldName) throw new Error(`The ${kind} to rename is required.`);
      if (oldName === newName) return { affected: 0, name: newName };

      const entry = this.listProductListEntries(kind).find((e) => e.id === oldName);
      if (!entry) throw new Error(`${kind === "article" ? "Article" : "Size"} "${oldName}" was not found.`);
      if (entry.renameBlockedReason) throw new Error(entry.renameBlockedReason);

      // UNIQUE(article, size) covers disabled rows too, so a clash anywhere is a clash.
      const clash = this.db
        .prepare(
          `SELECT a.${other} AS other FROM article_sizes a
           WHERE a.${column} = ? AND a.${other} IN (SELECT ${other} FROM article_sizes WHERE ${column} = ?)
           LIMIT 1`
        )
        .get(newName, oldName) as { other: string } | undefined;
      if (clash) {
        const pair = kind === "article" ? `${newName} / ${clash.other}` : `${clash.other} / ${newName}`;
        throw new Error(`${pair} already exists. Disable the wrong product instead of renaming into an existing one.`);
      }

      this.db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const a = this.db.prepare(`UPDATE article_sizes SET ${column} = ?, updated_at = ? WHERE ${column} = ?`).run(newName, now, oldName);
        const v = this.db.prepare(`UPDATE product_variants SET ${column} = ?, updated_at = ? WHERE ${column} = ?`).run(newName, now, oldName);
        this.db.exec("COMMIT");
        return { affected: Number(a.changes) + Number(v.changes), name: newName };
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* no transaction to roll back */ }
        throw error;
      }
    }

    const meta = PRODUCT_LIST_TABLES[kind];
    const existing = this.db
      .prepare(`SELECT id FROM ${meta.table} WHERE id = ? AND deleted_at IS NULL LIMIT 1`)
      .get(String(input.id ?? "")) as { id: string } | undefined;
    if (!existing) throw new Error(`That ${meta.label} was not found.`);
    const duplicate = this.db
      .prepare(`SELECT id FROM ${meta.table} WHERE UPPER(${meta.nameColumn}) = ? AND id <> ? AND deleted_at IS NULL LIMIT 1`)
      .get(newName, existing.id) as { id: string } | undefined;
    if (duplicate) throw new Error(`A ${meta.label} named ${newName} already exists.`);
    const result = this.db
      .prepare(`UPDATE ${meta.table} SET ${meta.nameColumn} = ?, updated_at = ? WHERE id = ?`)
      .run(newName, now, existing.id);
    return { affected: Number(result.changes), name: newName };
  },

  /**
   * Removes one dropdown value. Groups and series are soft-deleted (only when unused);
   * an article or size is removed by disabling every product that carries it, exactly
   * as Product List's Disable does. Returns how many rows were affected.
   */
  deleteProductListEntry(this: SqliteDatabase, input: { kind: ProductListKind; id: string; actor?: string | null; reason?: string }): { affected: number } {
    const kind = input.kind;
    const now = new Date().toISOString();
    const actor = String(input.actor ?? "").trim() || null;
    const reason = String(input.reason ?? "").trim() || `Removed from Product Lists${actor ? ` by ${actor}` : ""}`;

    if (this.isValueList(kind)) {
      const column = kind === "article" ? "article" : "size";
      const value = String(input.id ?? "").trim();
      if (!value) throw new Error(`The ${kind} to delete is required.`);
      const entry = this.listProductListEntries(kind).find((e) => e.id === value);
      if (!entry) throw new Error(`${kind === "article" ? "Article" : "Size"} "${value}" was not found.`);
      if (entry.deleteBlockedReason) throw new Error(entry.deleteBlockedReason);

      this.db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const a = this.db
          .prepare(
            `UPDATE article_sizes SET status = 'DISABLED', deleted_at = ?, deleted_by = ?, delete_reason = ?, updated_at = ?
             WHERE ${column} = ? AND deleted_at IS NULL`
          )
          .run(now, actor, reason, now, value);
        const v = this.db
          .prepare(
            `UPDATE product_variants SET status = 'DISABLED', deleted_at = ?, deleted_by = ?, delete_reason = ?, updated_at = ?
             WHERE ${column} = ? AND deleted_at IS NULL`
          )
          .run(now, actor, reason, now, value);
        this.db.exec("COMMIT");
        return { affected: Number(a.changes) + Number(v.changes) };
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* no transaction to roll back */ }
        throw error;
      }
    }

    const meta = PRODUCT_LIST_TABLES[kind];
    const entry = this.listProductListEntries(kind).find((e) => e.id === String(input.id ?? ""));
    if (!entry) throw new Error(`That ${meta.label} was not found.`);
    if (entry.deleteBlockedReason) throw new Error(entry.deleteBlockedReason);
    const result = this.db
      .prepare(`UPDATE ${meta.table} SET is_active = 0, deleted_at = ?, deleted_by = ?, delete_reason = ?, updated_at = ? WHERE id = ?`)
      .run(now, actor, reason, now, entry.id);
    return { affected: Number(result.changes) };
  },

  listUniqueArticles(this: SqliteDatabase): string[] {
    // Sourced from article_sizes (Product Master), not product_variants: a
    // product created here has no color/variant row until one is added, but
    // must still be selectable in this page's own Article/Size dropdowns.
    const rows = this.db
      .prepare(`SELECT DISTINCT article FROM article_sizes WHERE deleted_at IS NULL AND status = 'ACTIVE' ORDER BY article ASC`)
      .all() as Array<{ article: string }>;

    return rows.map((row) => row.article);
  },

  listUniqueSizesByArticle(this: SqliteDatabase, article: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT size FROM article_sizes WHERE article = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY size ASC`)
      .all(article.trim()) as Array<{ size: string }>;

    return rows.map((row) => row.size);
  },

  listUniqueColorsByArticle(this: SqliteDatabase, article: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT color FROM product_variants WHERE article = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY color ASC`)
      .all(article.trim()) as Array<{ color: string }>;

    return rows.map((row) => row.color);
  },
};

export type ProductsMethods = typeof productsMethods;
