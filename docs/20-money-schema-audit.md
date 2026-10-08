# Money Schema Audit and Migration Proposal

**Date:** 2026-09-18
**Status:** Audit complete. **No schema migration performed** — it needs the owner's decision (see §5).
**Companion:** `docs/19-claude-md-compliance-audit.md` (R15), `packages/domain/src/money.ts`.

## 1. Current model

Every monetary value in the local SQLite schema is a `REAL` column holding **rupees** (e.g. `650`, `7800`, `240`). Nothing stores paisa. Values are whole rupees in practice (the Rate List, discounts and vouchers are entered in whole rupees; the live database has `0` fractional prices), but nothing in the schema prevents `650.5`.

Since the compliance pass, **all arithmetic** on these values goes through `@erp/domain/money.ts`, which converts to integer paisa, computes, and converts back — so additions, ledger running balances, line totals and the balance-limit check are exact even though storage is floating point. What remains floating point is:

1. the storage type itself (`REAL`), and
2. `SUM(...)` aggregates executed inside SQLite (party balance, opening balances, voucher totals, supplier balances) — exact for whole rupees and for sums below 2^53 paisa-equivalents, but not guaranteed exact for fractional rupees.

The cloud schema (`supabase/schema.sql`) declares `numeric(12,2)` / `numeric(14,2)` — decimal rupees with two places — for the product and report tables it defines. It does not yet define the sales/cash/discount tables at all.

## 2. Column inventory

Unit is **rupees** for every row below (verified by sampling the live database and by the input paths: every writer receives rupee values from the UI without conversion).

| Table | Column | SQLite type | Unit | Example (live) | Writers (`SqliteDatabase`) | Readers |
|---|---|---|---|---|---|---|
| `article_sizes` | `cost_price`, `selling_price` | REAL | Rs | 550, 600 | `getOrCreateArticleSize`, `createProduct`, `updateProduct`, `resolveVariantForColor` | `listProducts`, `getProduct`, `getSaleableVariant`, `listInventory`, `getDashboardSnapshot` (SUM cost × qty), `getReport`, `getQrDetail` |
| `product_variants` | `cost_price`, `selling_price` | REAL | Rs | 550, 600 (synced copy of ArticleSize) | same as above (kept in sync by `updateProduct`) | `getSaleableVariant`, `listInventory`, `getReport` |
| `parties` | `balance_limit` | REAL, nullable | Rs (NULL = no limit) | NULL | `createParty`, `updateParty` | `getParty`, `listParties`, `createSaleVoucher` (limit check) |
| `inventory_items` (raw material) | `cost_price` | REAL, nullable | Rs | — (no rows) | `createInventoryItem`, `updateInventoryItemPrice` | `listInventoryItems`, `getPurchaseVoucher` |
| `party_article_discounts` | `discount_per_pair` | REAL ≥ 0 | Rs per pair | — | `createPartyArticleDiscount` | `resolveDiscount`, `getPartyDiscountReport` |
| `party_article_series_discounts` | `discount_per_pair` | REAL ≥ 0 | Rs per pair | — | `createPartyArticleSeriesDiscount` | `resolveDiscount`, `getPartyDiscountReport` |
| `party_product_group_discounts` | `discount_per_pair` | REAL ≥ 0 | Rs per pair | — | `createPartyProductGroupDiscount` | `resolveDiscount`, `getPartyDiscountReport` |
| `party_price_range_discounts` | `start_price`, `end_price`, `discount_per_pair` | REAL ≥ 0 | Rs | — | `createPartyPriceRangeDiscount` | `resolveDiscount` (`start_price <= price <= end_price`), `getPartyDiscountReport` |
| `sale_vouchers` | `total_amount` | REAL | Rs | — | `createSaleVoucher` (0), `recalculateVoucherTotals` (SUM of lines) | `getCurrentPartyBalance`, `getSaleVoucher`, `listSaleVouchers`, `getCustomerLedger`, `getCustomerLedgerWithCash`, `listCustomerBalances`, `listDispatchSessions` |
| `sale_voucher_line_items` | `unit_price` (per pair), `discount` (line total), `discount_per_pair`, `total_price` | REAL, CHECK > 0 / ≥ 0 | Rs | — | `addVoucherLineItem`, `updateVoucherLineItem` (via `saleLineTotal` / `discountPerPairFromTotal`) | `getSaleVoucher`, `recalculateVoucherTotals`, `getCustomerLedger`, `getCustomerLedgerWithCash` |
| `cash_vouchers` | `receipt_amount`, `payment_amount` | REAL ≥ 0 (exactly one > 0) | Rs | — | `createCashVoucher`, `updateCashVoucher` | `getCurrentPartyBalance`, `getCashVoucher*`, `listCashVouchers`, ledgers, `listCustomerBalances`, `listSupplierBalances` |
| `cash_voucher_lines` | `receipt_amount`, `payment_amount` | REAL ≥ 0 | Rs | — | `createCashVoucher`, `updateCashVoucher` | party-balance and ledger SUMs |
| `purchase_vouchers` | `total_amount` | REAL | Rs | — | `createPurchaseVoucher`, `updatePurchaseVoucher` (via `addMoney`/`multiplyMoney`) | `getPurchaseVoucher`, `listPurchaseVouchers`, `getSupplierLedger`, `listSupplierBalances` |
| `purchase_voucher_line_items` | `unit_price`, `total_price` | REAL | Rs | — | `createPurchaseVoucher`, `updatePurchaseVoucher` | `getPurchaseVoucher` |
| `report_daily_summary` | `inventory_value_cost`, `inventory_value_sales` | REAL | Rs | — | *(no writer in code today)* | *(no reader)* |
| `app_settings` | `rate-list.previous-rates` (JSON text) | TEXT | Rs inside JSON | `{"A_TYPE:SK6:7/10":600}` | `updateProduct` handler, `ProductListPage.saveSettings` | `ProductListPage` (rate list "difference" view) |

Non-monetary REAL columns that must **not** be touched by a money migration: `purchase_vouchers.total_quantity` (raw-material quantity, may be fractional), `sale_voucher_line_items.quantity` (dozens, may be 0.5), `inventory_item_attribute_values.number_value`, `metrics_timeseries.metric_value`.

## 3. Conversions in the application

- **UI → DB:** the Sale Voucher form, Cash Voucher form, Purchase Voucher form, Discount Policy page and Product form send rupee numbers as typed; `main.ts` narrows them with `Number(...)`; the data layer stores them as-is. No paisa conversion anywhere.
- **DB → UI:** rows are returned as rupee numbers; `formatMoney()` / page-local formatters display them (two conventions exist: `1,234.00` in `app/format.ts` and `PKR 1,234` in `StockPage`).
- **Derived values:** `computeBTypePrice` (rupees − 150/170/200), `calculateSaleLine`, `saleLineTotal`, `discountPerPairFromTotal`, `addMoney`/`subtractMoney`/`multiplyMoney` — all in `@erp/domain`, all paisa-exact internally, all returning rupees.
- **Aggregates in SQL:** `SUM(total_amount)`, `SUM(receipt_amount)`, `SUM(payment_amount)`, `SUM(total_price)`, `SUM(cost_price × quantity_on_hand)` — floating-point inside SQLite.

## 4. Migration proposal (not executed)

### Target
Integer **paisa** in every monetary column (`INTEGER`, 1 rupee = 100 paisa), with the domain helpers `toPaisa`/`fromPaisa` as the only conversion points, and SQL aggregates becoming exact integer sums.

### Strategy — additive, then switch, then retire

1. **Add** parallel `*_paisa INTEGER` columns (migration `028_money_paisa_columns`): for every column in §2 except the JSON setting. Populate with `CAST(ROUND(old * 100) AS INTEGER)`, `NULL` where the source is `NULL`. Both columns coexist; the old column stays authoritative.
2. **Dual-write** in `SqliteDatabase`: every writer in §2 writes both columns (rupees as today, paisa via `toPaisa`). A verification query in `captureHealthSnapshot` counts rows where `ABS(old*100 − new) > 0.5` and reports drift.
3. **Switch readers** to the paisa columns behind a single flag in `SqliteDatabase` (`MONEY_STORAGE = "PAISA" | "RUPEES"`), converting with `fromPaisa` at the boundary so the application/renderer contract (rupee numbers) does not change. SQL aggregates switch to the integer columns.
4. **Retire** the REAL columns in a later release (`029_money_drop_rupee_columns`) only after one full backup cycle and the drift check has been zero on every workstation.

### Backward compatibility
- The renderer and IPC contract keep exchanging **rupee numbers**; only storage changes.
- Backups taken before step 4 restore into either version because both column sets exist.
- The cloud schema should adopt `bigint` paisa for the same tables when the sales/cash tables are added to Supabase (they do not exist there yet), so sync never has to convert.

### Data conversion
`ROUND(value × 100)` is exact for every value that has at most two decimals. Rows with more than two decimals (none exist in the live database; the check runs in step 1 and aborts the migration if any are found) need an explicit business decision on rounding.

### Verification
- Row-by-row equality report after step 1 (`old × 100 == new` within 0.5 paisa) written to `audit_log`.
- Existing data tests (`sqliteDatabase.test.ts` voucher/ledger/balance-limit suites) run against both storage modes.
- Ledger closing balances per party compared before/after on a copy of the live database.

### Rollback
- Steps 1–3 are reversible by flipping `MONEY_STORAGE` back to `"RUPEES"` (the rupee columns are still written).
- Step 4 is the only destructive step; it is preceded by a mandatory `createBackup("MANUAL")`, and the `028`/`029` down-migrations recreate and repopulate the rupee columns from paisa.

## 5. Decision required before any of §4 is implemented

1. **Confirm the unit**: all stored amounts are rupees (this audit says yes; the owner should confirm no workstation stores paisa or fractional rupees).
2. **Fractional rupees policy**: may prices/discounts ever have paisa (e.g. Rs 12.50)? If never, an `INTEGER` rupee model (no ×100) would also be exact and simpler; CLAUDE.md R15 specifies paisa, so paisa is the default proposal.
3. **Timing**: the live database has no sale/cash/purchase rows yet, so the conversion is cheapest **now**; once real vouchers exist it still works but the verification window matters more.
4. **Cloud alignment**: agree that the future Supabase tables for sales/cash use `bigint` paisa rather than `numeric(12,2)`.

**Until then, do not change:** the column types in `local-schema.sql`, the CHECK constraints on money columns, `getCurrentPartyBalance`, `recalculateVoucherTotals`, the ledger SUM queries, or the `formatMoney` display contract.
