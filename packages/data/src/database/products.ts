// Product master: ArticleSize + colour variants, groups, series, dropdown value lists.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance; bodies are unchanged from the original class.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { InventoryRow, PagedResult, ProductListEntry, ProductListKind, ProductListQuery, ProductVariantRecord, SaleableVariant } from "./types.js";
import { fromPaisa, fromPaisaOrNull, multiplyMoney, subtractMoney, toPaisaOrNull } from "@erp/domain";
import { IN_STORE_STOCK_SQL } from "./shared.js";

const PRODUCT_LIST_TABLES: Record<
    "main-group" | "product-group" | "article-series",
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
            ass.main_group_id,
            ass.product_group_id,
            ass.article_series_id,
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
      mainGroupId: row.main_group_id ? String(row.main_group_id) : null,
      groupId: row.product_group_id ? String(row.product_group_id) : null,
      articleSeriesId: row.article_series_id ? String(row.article_series_id) : null,
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
    mainGroupId?: string;
    productGroupId?: string;
    articleSeriesId?: string;
    updateExisting?: boolean;
    productCode?: string;
    status?: "ACTIVE" | "DISABLED";
  }): string {
    const article = input.article.trim().toUpperCase();
    const size = input.size.trim();
    const costPricePaisa = toPaisaOrNull(input.costPrice);
    const sellingPricePaisa = toPaisaOrNull(input.sellingPrice);
    const existing = this.db.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string } | undefined;
    if (existing) {
      if (input.updateExisting) {
        this.db.prepare(`UPDATE article_sizes SET description = ?, cost_price_paisa = ?, selling_price_paisa = ?, main_group_id = ?, product_group_id = ?, article_series_id = ?, status = ?, updated_at = ? WHERE id = ?`)
          .run(input.description ?? null, costPricePaisa, sellingPricePaisa, input.mainGroupId ?? null, input.productGroupId ?? null, input.articleSeriesId ?? null, input.status ?? "ACTIVE", new Date().toISOString(), existing.id);
      }
      return existing.id;
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO article_sizes (id, product_code, article, size, description, cost_price_paisa, selling_price_paisa, main_group_id, product_group_id, article_series_id, status, created_at, updated_at, deleted_at, deleted_by, delete_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`)
      .run(id, input.productCode ?? this.getNextProductCode(), article, size, input.description ?? null, costPricePaisa, sellingPricePaisa, input.mainGroupId ?? null, input.productGroupId ?? null, input.articleSeriesId ?? null, input.status ?? "ACTIVE", now, now);
    return id;
  },

  createProduct(this: SqliteDatabase, input: {
    article: string;
    color?: string;
    size: string;
    description?: string;
    costPrice?: number;
    sellingPrice?: number;
    mainGroupId?: string;
    productGroupId?: string;
    articleSeriesId?: string;
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
      const id = crypto.randomUUID();
      this.db.prepare(`INSERT INTO product_variants (id, article, color, size, description, cost_price_paisa, selling_price_paisa, main_group_id, product_group_id, article_series_id, article_size_id, status, created_at, updated_at, deleted_at, deleted_by, delete_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`)
        .run(id, input.article.trim().toUpperCase(), color, input.size.trim(), input.description ?? null, costPricePaisa, sellingPricePaisa, input.mainGroupId ?? null, input.productGroupId ?? null, input.articleSeriesId ?? null, articleSizeId, input.status ?? "ACTIVE", now, now);
      if (firstId === articleSizeId) firstId = id;
    }
    // Existing variants keep independent copies of these fields (read by sale/discount/report queries), so keep them in sync.
    this.db.prepare(`UPDATE product_variants SET description = ?, cost_price_paisa = ?, selling_price_paisa = ?, main_group_id = ?, product_group_id = ?, article_series_id = ?, updated_at = ? WHERE article_size_id = ? AND deleted_at IS NULL`)
      .run(input.description ?? null, costPricePaisa, sellingPricePaisa, input.mainGroupId ?? null, input.productGroupId ?? null, input.articleSeriesId ?? null, now, articleSizeId);
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
      mainGroupId?: string;
      productGroupId?: string;
      articleSeriesId?: string;
      colors?: string[];
      status?: "ACTIVE" | "DISABLED";
    }
  ): void {
    const articleSize = this.getProduct(id);
    const articleSizeId = articleSize?.articleSizeId ?? id;
    const now = new Date().toISOString();
    const costPricePaisa = toPaisaOrNull(input.costPrice);
    const sellingPricePaisa = toPaisaOrNull(input.sellingPrice);
    this.db.prepare(`UPDATE article_sizes SET description = ?, cost_price_paisa = ?, selling_price_paisa = ?, main_group_id = ?, product_group_id = ?, article_series_id = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(input.description ?? null, costPricePaisa, sellingPricePaisa, input.mainGroupId ?? null, input.productGroupId ?? null, input.articleSeriesId ?? null, input.status ?? "ACTIVE", now, articleSizeId);
    // Existing variants keep independent copies of these fields (read by sale/discount/report queries), so keep them in sync.
    this.db.prepare(`UPDATE product_variants SET description = ?, cost_price_paisa = ?, selling_price_paisa = ?, main_group_id = ?, product_group_id = ?, article_series_id = ?, status = ?, updated_at = ? WHERE article_size_id = ? AND deleted_at IS NULL`)
      .run(input.description ?? null, costPricePaisa, sellingPricePaisa, input.mainGroupId ?? null, input.productGroupId ?? null, input.articleSeriesId ?? null, input.status ?? "ACTIVE", now, articleSizeId);
    const existing = this.db.prepare("SELECT article, size FROM article_sizes WHERE id = ?").get(articleSizeId) as { article: string; size: string } | undefined;
    if (!existing) return;
    for (const color of (input.colors ?? []).map((value) => value.trim().toUpperCase()).filter((value) => value && value !== "N/A" && value !== "NULL" && value !== "UNDEFINED")) {
      const found = this.db.prepare("SELECT id FROM product_variants WHERE article_size_id = ? AND color = ? AND deleted_at IS NULL LIMIT 1").get(articleSizeId, color) as { id: string } | undefined;
      if (!found) {
        this.db.prepare(`INSERT INTO product_variants (id, article, color, size, description, cost_price_paisa, selling_price_paisa, main_group_id, product_group_id, article_series_id, article_size_id, status, created_at, updated_at, deleted_at, deleted_by, delete_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`)
          .run(crypto.randomUUID(), existing.article, color, existing.size, input.description ?? null, costPricePaisa, sellingPricePaisa, input.mainGroupId ?? null, input.productGroupId ?? null, input.articleSeriesId ?? null, articleSizeId, input.status ?? "ACTIVE", now, now);
      }
    }
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
    const discountSql = meta.discountTable
      ? `(SELECT COUNT(1) FROM ${meta.discountTable} d WHERE d.${meta.discountFk} = g.id AND d.deleted_at IS NULL)`
      : "0";
    const rows = this.db
      .prepare(
        `SELECT g.id, g.${meta.nameColumn} AS name,
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
