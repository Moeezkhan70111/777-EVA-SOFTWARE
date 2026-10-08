# ERP Architecture Audit

**Audit mode:** Read-only
**Audit date:** 2026-08-20
**Scope:** Current workspace source, SQLite schema, migration files, Supabase schema, renderer tests, and package boundaries.

> This document records the current implementation. It is not a proposed rewrite. Where the repository does not prove behavior, the document says **NOT VERIFIED FROM CURRENT CODEBASE**.

## Executive Findings

1. The desktop application is an Electron process with a React renderer. The renderer reaches SQLite only through the preload bridge and `ipcMain` handlers.
2. The local SQLite database is the implemented operational store. `packages/sync/src/outboxSync.ts` is a stub and no Supabase write path for current business modules is verified.
3. The canonical product identity in persisted transactional records is `product_variants.id`, exposed as `productVariantId`.
4. The product dropdown is intentionally grouped by `article + size` for display. The color map carries actual variant IDs. This creates a display grouping separate from variant identity.
5. Stock is projected by variant in `stock_projection_by_variant.quantity_on_hand` and read by `listInventory()` and `getSaleableVariant()`.
6. Pair Rate is the selected variant's `product_variants.selling_price`. The Sale Voucher UI has separate `selectedVariant`, `tplPairRate`, and `tplPairDisc` state.
7. Discount resolution is backend-owned by `SqliteDatabase.resolveDiscount()`. The hierarchy is ARTICLE, ARTICLE_SERIES, PRICE_RANGE, PRODUCT_GROUP, NONE, with early return and no stacking.
8. The UI resolves a discount for display and the backend resolves again during `addVoucherLineItem()`. The persisted `discount` is supplied by the UI when present, while persisted `discount_per_pair` and `discount_source` come from the backend resolver. This is a potential UI/persistence disagreement.
9. Party balance and balance-limit behavior is implemented in SQLite. The Sale Voucher form displays balance and limit information and passes `projectedTotal`; `createSaleVoucher()` performs the backend limit check.
10. The current Supabase schema does not contain the local party, discount, sale voucher, line-item, dispatch-session, or cash-voucher tables. Their cloud synchronization is **NOT VERIFIED FROM CURRENT CODEBASE**.

## 1. System Architecture

### ASCII architecture diagram

```text
+----------------------------- Electron Main Process ----------------------------+
| apps/desktop/src/main.ts                                                       |
| - owns runtime paths and SQLite connection                                     |
| - registers ipcMain handlers                                                   |
| - constructs @erp/data SqliteDatabase                                         |
| - constructs @erp/application scan use cases                                  |
| - invokes scan/dispatch/return application services                           |
+-------------------------------+-----------------------------------------------+
                                |
                         IPC invoke/handle
                                |
+-------------------------------v-----------------------------------------------+
| apps/desktop/src/preload.cts                                                   |
| contextBridge.exposeInMainWorld("desktop", { api: ... })                       |
+-------------------------------+-----------------------------------------------+
                                |
                         window.desktop.api
                                |
+-------------------------------v-----------------------------------------------+
| React Renderer: apps/desktop/src/renderer                                      |
| - pages, React state, effects, form validation                                 |
| - useDesktopApi() returns window.desktop.api                                  |
+-------------------------------+-----------------------------------------------+
                                |
                    typed API calls / callback results
                                |
+-------------------------------v-----------------------------------------------+
| @erp/application                                                               |
| - process, dispatch, return, party use cases                                  |
| - ports/interfaces for transactions, stock, QR, outbox                       |
+-------------------------------+-----------------------------------------------+
                                |
                    implemented directly by SqliteDatabase
                                |
+-------------------------------v-----------------------------------------------+
| @erp/data                                                                       |
| packages/data/src/sqliteDatabase.ts                                            |
| - SQL reads/writes                                                             |
| - transactions and projections                                                 |
| - voucher, party, discount, ledger, cash, dispatch operations                 |
+-------------------------------+-----------------------------------------------+
                                |
                         node:sqlite / WAL
                                |
+-------------------------------v-----------------------------------------------+
| SQLite: erp.local.sqlite                                                       |
| local-schema.sql + versioned startup migrations                                |
+---------------------------------------------------------------------------------+

+----------------------------- Supporting packages ------------------------------+
| @erp/domain: QR payload/parser and domain value contracts                      |
| @erp/scanner: scanner frame assembly                                           |
| @erp/sync: OutboxSyncService; current runOnce() is a stub                     |
| Supabase schema: cloud target/baseline, not proven to be active at runtime     |
+---------------------------------------------------------------------------------+
```

### Layer responsibilities

| Layer | Responsibility | Important files/functions | Inputs | Outputs/dependencies |
|---|---|---|---|---|
| Electron main | Runtime, IPC registration, service composition, error translation | `apps/desktop/src/main.ts`, `initializeServices()`, `registerIpcHandlers()` | Renderer IPC calls, scanner input | IPC results; depends on data/application/domain |
| Preload | Security boundary and API projection | `apps/desktop/src/preload.cts` | IPC channel arguments | `window.desktop.api`; depends on Electron `contextBridge` |
| React renderer | User interaction, local form state, display, client-side calculations | `SaleVoucherFormPage.tsx`, pages, `useDesktopApi.ts` | User selections and API promises | IPC calls and rendered state; depends on typed `desktopApi.ts` |
| Application | Use-case orchestration and ports for production/dispatch/return | `packages/application/src/processScanUseCase.ts`, `dispatchScanUseCase.ts`, `returnScanUseCase.ts`, `ports.ts` | Parsed QR and operational context | Transactional repository calls; depends on domain types |
| Domain | QR parsing and domain contracts | `packages/domain/src/qr.ts`, `party.ts` | Raw QR strings | Canonical QR payload or domain error |
| Data | SQLite persistence, SQL queries, projections, business resolver logic | `packages/data/src/sqliteDatabase.ts`, `local-schema.sql` | Typed method inputs | Rows, projections, voucher/ledger results |
| Scanner | Input framing utility | `packages/scanner/src/scannerFrameAssembler.ts` | Scanner frames | Scan frame result |
| Sync | Intended outbox-to-cloud boundary | `packages/sync/src/outboxSync.ts` | Outbox port | `SyncResult`; current implementation returns zero counts |
| Supabase | Declared cloud schema and RLS baseline | `supabase/schema.sql`, `migrations/supabase` | Deployment SQL | PostgreSQL schema; active runtime integration is **NOT VERIFIED FROM CURRENT CODEBASE** |

### Package dependency facts

- `@erp/application` imports domain types and defines repository ports.
- `@erp/data` implements application ports through `SqliteDatabase`.
- `@erp/desktop` dynamically imports `@erp/data` and `@erp/application` in the main process.
- Renderer code does not import SQLite or application use cases directly.
- `@erp/sync` has no verified caller from the current desktop main process.

## 2. Database Schema

The primary implemented schema is `packages/data/src/local-schema.sql`. SQLite is configured with WAL and foreign keys. The current local schema contains the following tables.

### Identity, organization, and access tables

| Table | Columns and types | Keys, constraints, defaults, behavior | Meaning |
|---|---|---|---|
| `factories` | `id TEXT`, `code TEXT`, `name TEXT`, `timezone TEXT`, `is_active INTEGER`, timestamps, soft-delete fields | PK `id`; unique `code`; `timezone` default `Asia/Karachi`; `is_active` default 1 | Factory master |
| `workstations` | `id TEXT`, `factory_id TEXT`, `workstation_code TEXT`, `device_id TEXT`, `name TEXT`, `is_active INTEGER`, timestamps, soft-delete fields | PK `id`; FK `factory_id`; unique workstation code and device ID; `is_active` default 1 | Scanner workstation |
| `devices` | `id TEXT`, `device_name TEXT`, `factory_id TEXT`, nullable `workstation_id TEXT`, `os_name TEXT`, `app_version TEXT`, `is_active INTEGER`, heartbeat/timestamps | PK `id`; FKs factory and optional workstation; `is_active` default 1 | Device registration and health |
| `operators` | `id TEXT`, nullable `external_auth_id TEXT`, `display_name TEXT`, `role_code TEXT`, `is_active INTEGER`, timestamps, soft-delete fields | PK `id`; no declared FK from `role_code`; `is_active` default 1 | User/operator master |
| `roles` | `role_code TEXT`, `role_name TEXT`, `is_system_role INTEGER`, timestamps | PK `role_code`; system flag default 1 | Role master |
| `role_permissions` | `role_code TEXT`, `permission_code TEXT`, `created_at TEXT` | Composite PK `(role_code, permission_code)`; FK role | Permission assignment |
| `app_settings` | `setting_key TEXT`, `setting_value TEXT`, `value_type TEXT`, `is_encrypted INTEGER`, `updated_by TEXT`, `updated_at TEXT` | PK setting key; `value_type` check string/number/boolean/json; encryption default 0 | Local settings |
| `audit_log` | `id TEXT`, `event_type TEXT`, `event_version INTEGER`, `entity_type TEXT`, `entity_id TEXT`, actor fields, timestamps, payload/hash | PK `id`; indexes on occurred time and entity | Audit records |

### Product, variant, series, and stock tables

| Table | Columns and types | Keys, constraints, defaults, behavior | Meaning |
|---|---|---|---|
| `product_variants` | `id TEXT`, `article TEXT`, `color TEXT`, `size TEXT`, nullable description/prices/group IDs, `status TEXT`, timestamps, soft-delete fields | PK `id`; unique `(article,color,size)`; FKs main group, product group, article series in current local schema; status default `ACTIVE` | Saleable variant master. This is the canonical item identity |
| `article_series` | `id TEXT`, `name TEXT`, nullable description, `is_active INTEGER`, timestamps, soft-delete fields | PK `id`; unique name; active default 1; name index | Article-series grouping |
| `main_groups` | `id TEXT`, `group_name TEXT`, nullable description, active flag, timestamps, soft-delete fields | PK `id`; unique group name; active default 1 | Higher-level product grouping |
| `product_groups` | Same shape as `main_groups` | PK `id`; unique group name; active default 1 | Discount/product grouping |
| `qr_master` | `qr_id TEXT`, `product_variant_id TEXT`, status/location fields, first event, timestamps, soft-delete fields | PK `qr_id`; FK variant; checks for status and location type; status has no default | One physical scanned unit and its current state |
| `production_events` | `id TEXT`, `qr_id TEXT`, `product_variant_id TEXT`, event fields, local timestamp/date/hour, factory/workstation/operator/device, article/color/size snapshots, metadata, sync status fields | PK `id`; FKs QR, variant, workstation, factory, optional operator; checks event type, event hour, sync status; indexes by date/variant/factory/event | Append-only operational history |
| `stock_projection_by_variant` | `product_variant_id TEXT`, `quantity_on_hand INTEGER`, `quantity_reserved INTEGER`, `quantity_damaged INTEGER`, nullable `last_event_ts TEXT`, `updated_at TEXT` | PK and FK variant; on-hand default 0 and nonnegative check | Variant-level stock projection; authoritative current on-hand source used by Sale Voucher |
| `stock_projection_by_location` | `product_variant_id TEXT`, `location_type TEXT`, `location_id TEXT`, `quantity_on_hand INTEGER`, `updated_at TEXT` | Composite PK `(product_variant_id,location_type,location_id)`; FK variant; location check | Location detail projection |

### Reporting, synchronization, backup, and health tables

| Table | Columns and types | Keys/constraints | Meaning |
|---|---|---|---|
| `report_daily_summary` | report date, factory ID, production/QR counts, cost/sales values, generated timestamp | Composite PK `(report_date,factory_id)`; FK factory; numeric defaults 0 | Daily report projection |
| `sync_outbox` | `id`, aggregate type/id, operation, dedupe key, JSON payload, status/lock/availability/attempt/error/timestamps | PK id; unique dedupe key; checks aggregate, operation, status; status index | Local pending sync/event queue |
| `backup_history` | id, backup type/path/checksum/size, verified flag/time, status, created time | PK id; checks backup type/status | Backup audit |
| `system_health_snapshots` | id, captured time, SQLite/Supabase/scanner flags, pending/failed counts, last sync, size/disk, backup, JSON details | PK id | Health snapshots |
| `metrics_counters` | metric key/value/update time | PK metric key | Current counters |
| `metrics_timeseries` | id, metric key/value, labels JSON, captured time | PK id; metric/time index | Time-series metrics |

### Parties, discounts, sales, dispatch, and cash tables

| Table | Columns and types | Keys, constraints, defaults, behavior | Meaning |
|---|---|---|---|
| `party_groups` | id, unique group name, description, active flag, timestamps, soft-delete fields | PK id; unique name; active default 1 | Party grouping |
| `parties` | id, unique name, type, contact fields, nullable party group, remarks, status, active flag, nullable `balance_limit`, timestamps, soft-delete fields | PK id; FK party group; type/status checks; status default ACTIVE; indexed name/city/group/status | Customer/supplier/etc. master and balance-limit owner |
| `party_article_discounts` | id, party ID, `article_id TEXT`, size scope, nullable size, discount per pair, timestamps, soft-delete | PK id; unique `(party_id,article_id,size_scope,size)`; FKs party and variant; nonnegative discount | Article-level discount rule; article ID points to a variant, resolver matches its article name |
| `party_article_series_discounts` | id, party ID, series ID, discount per pair, timestamps, soft-delete | PK id; unique `(party_id,article_series_id)`; FKs party and series | Series rule |
| `party_price_range_discounts` | id, party ID, start/end price, discount per pair, timestamps, soft-delete | PK id; unique `(party_id,start_price,end_price)`; FK party; nonnegative bounds/discount | Price-range rule |
| `party_product_group_discounts` | id, party ID, product group ID, discount per pair, timestamps, soft-delete | PK id; unique `(party_id,product_group_id)`; FKs party/group | Product-group rule |
| `sale_vouchers` | id, unique voucher number, party ID, date/book/reference/remarks, total quantity/amount, status, timestamps, soft-delete fields | PK id; unique voucher number; FK party; status DRAFT/FINALIZED/CANCELLED; totals default 0 | Sale header |
| `sale_voucher_line_items` | id, voucher ID, variant ID, quantity, unit price, total discount, discount per pair/source, total price, timestamps, soft-delete | PK id; FKs voucher and variant; quantity/price/discount/total checks; voucher FK cascade; indexes by voucher and variant | Transactional line with variant ID and price/discount snapshot |
| `dispatch_sessions` | id, unique voucher ID, status, started/completed/timestamps | PK id; unique voucher ID; FK voucher; status PENDING/IN_PROGRESS/COMPLETED/CANCELLED | Dispatch job generated for a voucher |
| `cash_vouchers` | id, unique integer voucher number, party ID, date, description, receipt/payment amounts, status, timestamps, soft-delete | PK id; unique number; FK party; active/cancelled check; exactly one of receipt/payment must be positive | Receipts/payments used by ledger and balance |

### Soft-delete behavior

The schema uses nullable `deleted_at`, `deleted_by`, and `delete_reason` on most business/master tables. Queries generally add `deleted_at IS NULL`. Some status filters are separate from soft deletion. `sale_voucher_line_items` and `sale_vouchers` are retained and marked deleted/cancelled rather than physically removed. `cash_vouchers` are cancelled and soft-deleted.

### SQLite migrations

- `migrations/sqlite/001_initial_schema.up.sql` is a placeholder and does not create the baseline schema.
- `migrations/sqlite/002_variant_relationships.up.sql` adds `main_group_id`, `product_group_id`, and `article_series_id` plus two indexes.
- `SqliteDatabase.bootConnection()` first executes `local-schema.sql`, then runs the migration runner and a historical `balance_limit` column alteration.
- The down migration for 002 intentionally does not drop columns because SQLite column removal is not treated as safely reversible.
- A complete historical migration chain is **NOT VERIFIED FROM CURRENT CODEBASE** because 001 is only a placeholder while `local-schema.sql` is applied directly.

### Supabase divergence

`supabase/schema.sql` defines the production-first scanner schema using PostgreSQL UUID/boolean/timestamp/json types, RLS, and updated-at triggers. The inspected file contains factories, workstations, devices, operators, roles, role permissions, product variants, QR, production, stock projections, reports, outbox, settings, backups, health, metrics, and audit tables.

The inspected Supabase schema does not define the local SQLite tables for:

- `parties`, `party_groups`
- `article_series`, `main_groups`, `product_groups`
- discount policy tables
- `sale_vouchers`, `sale_voucher_line_items`
- `dispatch_sessions`
- `cash_vouchers`

Their cloud representation and sync behavior are **NOT VERIFIED FROM CURRENT CODEBASE**.

## 3. Product and Variant Identity

### Verified canonical identity

```text
product_variants.id
        |
        +--> product_variants.article
        +--> product_variants.size
        +--> product_variants.color
        +--> product_variants.selling_price
        +--> product_variants.article_series_id
        +--> product_variants.product_group_id
        +--> stock_projection_by_variant.product_variant_id
        +--> sale_voucher_line_items.product_variant_id
        +--> qr_master.product_variant_id
        +--> production_events.product_variant_id
```

The database uniqueness rule is `(article, color, size)`, but that tuple is a uniqueness constraint, not the transactional identity. The persisted foreign-key identity is the variant ID.

### Representations found in code

| Representation | Location | Role | Risk |
|---|---|---|---|
| Variant ID | `product_variants.id`, `productVariantId`, `tplColorId`, QR and voucher FKs | Canonical persistence identity | Correct when used consistently |
| `article + size` | `listProducts()` groups by these fields; `colorKey` and `colorMap` use `article|||size` | Display grouping | Not unique when multiple colors exist |
| `article + color + size` | Schema unique constraint; QR parser payload; `getOrCreateVariant()` lookup | Natural-key lookup at scan/product creation | Can diverge from ID if normalized differently |
| Representative product row | `listProducts()` uses `GROUP BY pv.article,pv.size` and `MIN(...)` metadata; renderer stores `uniqueProducts` | Product dropdown display | May combine metadata from different colors and must not be used for selected-variant price/metadata |
| `colorMap` | Renderer `Map<string, Array<{productId,color}>>` | Maps article-size display group to actual variant IDs/colors | It is an identity index, not the source for price/stock |
| `inventory` map | Renderer `Map<variantId, InventoryRow>` | Cached inventory rows by variant | Contains copies of price and stock |
| `selectedVariant` | Renderer `SaleableVariant` | Current authoritative read for selected color | Correct selected-item state |
| Line item snapshot | Renderer `lineItems` and DB line items | Historical transaction values | Correct for saved transaction; not current inventory source |

### Dangerous duplication

- `product_variants.selling_price`, `InventoryRow.sellingPrice`, `ProductRow.sellingPrice`, `selectedVariant.sellingPrice`, and `LineItem.pairRate` can all represent price at different times.
- `stock_projection_by_variant.quantity_on_hand`, `InventoryRow.quantity`, and rendered line stock are copies/derivations.
- `listProducts()` representative metadata can be unrelated to the selected color even when the actual selected variant is known.
- The backend discount resolver intentionally matches article rules by article string after loading the selected variant. This is business matching, not variant identity, and must not be confused with selecting a variant.

## 4. Inventory and Stock Flow

```text
stock_projection_by_variant.quantity_on_hand
        |
        +--> SqliteDatabase.listInventory()
        |       SELECT product_variants LEFT JOIN stock_projection_by_variant
        |
        +--> SqliteDatabase.getSaleableVariant(variantId)
        |       SELECT by product_variants.id LEFT JOIN stock projection
        |
        +--> ipcMain erp:list-inventory / erp:get-saleable-variant
        +--> preload api.listInventory / api.getSaleableVariant
        +--> renderer inventory Map and selectedVariant
        +--> colorMap/colorOpts for available color display
        +--> stock strip total and per-color labels
        +--> line-item stock display by inventory.get(productVariantId)
        |
        +--> save does not decrement inventory directly
                dispatch scan later decrements projection by variant
```

### Detailed behavior

1. `listInventory("")` returns one row per non-disabled product variant using `COALESCE(spv.quantity_on_hand,0)`.
2. `loadMasterData()` stores rows in `inventory: Map<productId, InventoryRow>`.
3. `colorMap` is built primarily from inventory rows, then product rows are added for variants with no inventory row. It stores only `{ productId, color }`.
4. `colorOpts` joins color-map entries back to `inventory`; missing inventory creates a zero-valued display fallback object.
5. `stockVariants` aliases `colorOpts`; `stockTotal` sums `quantity` across colors for the selected article/size.
6. Saved line stock display looks up `inventory.get(it.productVariantId)?.quantity ?? 0`.
7. `getSaleableVariant()` separately reads exact variant metadata and stock by ID for the selected color.
8. Production increments stock in a transaction. Dispatch decrements it in a transaction. Return increments it in a transaction. Sale Voucher line creation itself does not change stock.

### Stock state writers

- `setInventory()` in `loadMasterData()`.
- `setColorMap()` in `loadMasterData()`.
- `setLineItems()` during voucher load/add/update/delete/reset; current stock is read from `inventory` at render time rather than stored as `availableStock`.
- `SqliteDatabase.incrementProduced()`, `decrementStock()`, and `incrementReturned()` mutate the database projection.

## 5. Pair Rate Flow

```text
product_variants.selling_price
        |
        +--> getSaleableVariant(selected variant ID)
        +--> ipcMain erp:get-saleable-variant
        +--> preload getSaleableVariant()
        +--> selectedVariant.sellingPrice
        +--> price useEffect
        +--> tplPairRate
        +--> calc(): dozen rate = pair rate * 12
        +--> lineItems.pairRate / sale_voucher_line_items.unit_price
```

### Authoritative field

`product_variants.selling_price` is authoritative for a selected variant. `listInventory()` also returns this value, but `inventory.sellingPrice` is a data-layer/UI copy, not a separate source of truth.

### Fallbacks and zero paths

- Current selected-variant price path does not fall back to `uniqueProducts`.
- If `getSaleableVariant()` returns null or a null/non-positive selling price, `tplPairRate` becomes 0.
- Product change and add/reset/navigation paths explicitly set `tplPairRate(0)`.
- The price effect writes `tplPairRate` from `selectedVariant`.
- The numeric input can manually overwrite it.
- `lineItems` stores a transactional copy when an item is added.
- A stale or arbitrary representative row is still present in `uniqueProducts`, but the current selected-variant price effect does not use it.

## 6. Discount Flow

### Call chain

```text
partyId + selectedVariant.id + tplPairRate
        |
SaleVoucherFormPage discount useEffect
        |
api.resolveProductDiscountWithPrice()
        |
preload -> erp:resolve-product-discount-with-price
        |
ipcMain handler
        |
SqliteDatabase.resolveProductDiscountWithPrice()
        |
getSaleableVariant(productVariantId)
        |
resolveDiscount({ partyId, article, size, articleSeriesId,
                  productGroupId, applicablePrice })
        |
return { discountPerPair, source, ruleId }
        |
tplPairDisc / tplDiscSource
```

At persistence:

```text
addVoucherLineItem(voucherId, productVariantId, quantity, unitPrice, discount)
        |
getSaleableVariant(productVariantId)
        |
resolveDiscount(selected variant metadata + input.unitPrice)
        |
calculate total discount if input.discount absent
        |
INSERT sale_voucher_line_items(discount, discount_per_pair, discount_source)
```

### Exact priority

1. **ARTICLE**
   - Requires `article`.
   - First checks `party_article_discounts` joined to `product_variants` by `article_id`, matching `pv.article` and `size_scope = ALL_SIZES`.
   - If absent, checks `SEPARATE_SIZES` matching `pv.article` and input `size`.
   - Uses `party_id`; ignores price, series, and group for this level.
   - `LIMIT 1`; no explicit `ORDER BY`. Duplicate active rows are prevented by the schema unique constraint unless soft-deleted history creates unusual data conditions.

2. **ARTICLE SERIES**
   - Requires selected variant `articleSeriesId`.
   - Matches `party_article_series_discounts.party_id` and `.article_series_id`.
   - `deleted_at IS NULL`; `LIMIT 1`; no date condition; no stacking.

3. **PRICE RANGE**
   - Requires finite `applicablePrice`.
   - Matches `start_price <= price AND end_price >= price` for the party and active rule.
   - `LIMIT 1`; no explicit tie-break order; no date condition.

4. **PRODUCT GROUP**
   - Requires selected variant `productGroupId`.
   - Matches party and group with `deleted_at IS NULL`; `LIMIT 1`; no date condition.

5. **NONE**
   - Returns zero and source NONE when party is absent, variant is missing, metadata is missing, or no rule matches.

Rules do not stack. The first matching branch returns immediately.

### Frontend/backend duplication risk

- The UI resolves once for display using `resolveProductDiscountWithPrice()`.
- The backend resolves again during `addVoucherLineItem()`.
- The UI passes its calculated total `discount` to persistence. The backend still calculates and stores `discount_per_pair` and `discount_source` from its own resolution.
- If price, rule data, or selected variant changes between calls, the UI total and stored metadata can disagree. This is a verified architectural risk, not a claimed current production incident.

## 7. Color Dropdown

```text
listProducts() + listInventory()
        |
loadMasterData()
        |
colorMap: "article|||size" -> [{ productId, color }]
        |
tplProductId selects representative article-size display row
        |
colorKey = tplProduct.article + "|||" + tplProduct.size
        |
colorIds = colorMap.get(colorKey)
        |
colorOpts = colorIds filtered by selectable-color predicate
        |
<select value={tplColorId}>
```

### Invalid color behavior

The current predicate rejects, after trim and uppercase normalization:

- empty strings
- `N/A`
- `NULL`
- `UNDEFINED`

It is applied when building `colorMap` from inventory and product rows, and again when deriving `colorOpts`. Therefore invalid color rows are not selectable through the current renderer path.

Before this predicate was added, only exact uppercase `N/A` was rejected. Whitespace/case variants could pass. `null`/`undefined`/empty values could also pass through product/inventory fallback construction. The database itself declares `color TEXT NOT NULL`, but old or externally created data may still contain sentinel text values; the UI does not treat colorless products as a separate product type.

### Selection behavior

- Product selection sets `tplProductId` and clears `tplColorId`.
- If the grouped article/size has exactly one color-map variant, product selection auto-selects that variant ID.
- Manual color selection sets `tplColorId` to the `<option>` value, which is the actual `productId` from `colorMap`.
- `tplColorId` triggers `getSaleableVariant(tplColorId)`.
- No array index, display label, or article/color string becomes the final selected identity.

## 8. Complete Sale Voucher Flow

```text
PARTY
  -> partyId
  -> getParty + getCustomerLedgerWithCash
  -> partyBalance / partyBalanceLimit

PRODUCT
  -> tplProductId (representative article-size display row)
  -> article + size group key

COLOR
  -> colorMap variant options
  -> tplColorId = product_variants.id

VARIANT
  -> getSaleableVariant(tplColorId)
  -> selectedVariant

STOCK
  -> inventory Map / selectedVariant.stockQuantity
  -> stock strip and line stock display

PAIR RATE
  -> selectedVariant.sellingPrice
  -> tplPairRate

DISCOUNT
  -> partyId + selectedVariant metadata + tplPairRate
  -> resolver hierarchy
  -> tplPairDisc / source

DOZEN RATE / TOTALS
  -> calc(): pairRate * 12; dozens * dozen rate; discount per pair * dozens * 12

QUANTITY
  -> tplDznQty; one dozen is 12 pairs and two cartons

VALIDATION
  -> party required; product/color/rate/quantity required before add
  -> create requires party and at least one line

CREATE
  -> createSaleVoucher({ partyId, projectedTotal })
  -> backend balance-limit check and sale_vouchers insert
  -> addVoucherLineItem for each line
  -> backend resolver and sale_voucher_line_items insert
  -> recalculateVoucherTotals
  -> dispatch_sessions row created for voucher

INVENTORY
  -> unchanged by voucher creation; dispatch later decrements projection

LEDGER
  -> sale_vouchers + cash_vouchers queries

HISTORY / DISPATCH
  -> production_events and dispatch session queries
```

### Quantity and money semantics

- `dznQty` is stored as sale-voucher quantity.
- `unitPrice`/`pairRate` is per pair.
- `dznRate = pairRate * 12`.
- `amount = dznQty * dznRate`.
- `totalDisc = pairDisc * 12 * dznQty`.
- `total = amount - totalDisc`.
- `sale_voucher_line_items.quantity` is therefore dozens, despite the database column being named quantity.
- Dispatch derives required pairs as `quantity * 12`.

## 9. Party Balance and Balance Limit

### Current balance

`getCurrentPartyBalance(partyId)` computes:

```text
SUM(sale_vouchers.total_amount)
+ SUM(active cash_vouchers.payment_amount)
- SUM(active cash_vouchers.receipt_amount)
```

It excludes soft-deleted rows and filters cash vouchers by ACTIVE status. The renderer uses `getCustomerLedgerWithCash()` for display, which derives opening/closing balance from sales and cash entries.

### Balance limit

- `parties.balance_limit` is nullable. Null means no limit.
- The renderer displays current balance, limit, available credit, and projected balance.
- `SaleVoucherFormPage.save()` passes `projectedTotal: totals.net` to `createSaleVoucher()`.
- `createSaleVoucher()` reads the party limit, current balance, adds projected voucher amount, and rejects when projected balance exceeds the limit.
- IPC maps the exception to `PARTY_BALANCE_LIMIT_EXCEEDED` with current, voucher, projected, limit, available, and exceeded values.
- A second check at line-item save is described in comments but the inspected `addVoucherLineItem()` implementation does not perform a second balance-limit query. The actual second-check behavior is **NOT VERIFIED FROM CURRENT CODEBASE** beyond the comment.
- Balance-limit enforcement is backend-side in `createSaleVoucher()`, which is the correct authoritative validation location in the current architecture.

## 10. React State Ownership

| Field | Source of truth | React state | DB source | Read functions | Writers/dependencies | Duplication/risk |
|---|---|---|---|---|---|---|
| `partyId` | Selected party ID | `partyId` | `parties.id` | `listParties`, `getParty` | party select, voucher load/reset; party effect depends on it | Header and resolver input |
| `partyBalance` | Ledger calculation | `partyBalance` | sale vouchers + cash vouchers | `getCustomerLedgerWithCash` | party effect | Display copy; async stale result possible |
| `partyBalanceLimit` | Party master | `partyBalanceLimit` | `parties.balance_limit` | `getParty` | party effect | Display copy; backend is authoritative |
| `tplProductId` | Display grouping selection | `tplProductId` | Representative `listProducts` row | `listProducts` | product handler/reset | Not canonical variant identity |
| `tplColorId` | Selected variant ID | `tplColorId` | `product_variants.id` | colorMap / color options | product/color handler/reset | Correct canonical selection |
| `selectedVariant` | Exact selected variant read | `selectedVariant` | variant + stock projection | `getSaleableVariant` | variant effect | Authoritative current selected variant |
| `inventory` | Inventory query snapshot | `Map<id,InventoryRow>` | product variant + stock projection | `listInventory` | master load | Duplicate stock and price copy |
| `colorMap` | Derived identity index | `Map<article|||size, ids/colors>` | product/inventory rows | `listProducts`, `listInventory` | master load | Article-size grouping; invalid value risk if filtering changes |
| `uniqueProducts` | Display representative rows | `ProductRow[]` | grouped `listProducts` query | `listProducts` | master load | Representative metadata can be cross-color |
| `tplPairRate` | selected variant selling price, then user edit | `tplPairRate` | `product_variants.selling_price` | `getSaleableVariant` | price effect, numeric input, reset paths | Transactional copy after add |
| `tplPairDisc` | resolver result, then user edit | `tplPairDisc` | discount rule tables | resolver IPC | discount effect, numeric input, reset paths | UI result can differ from backend metadata |
| `tplDznQty` | User input | `tplDznQty` | Not stored until line add | none | numeric input/reset | Quantity is dozens |
| `lineItems` | Current voucher draft | `lineItems` | DB voucher line items when loaded/saved | get/create/add voucher APIs | load/add/update/delete/reset | Correct transaction snapshot but copies price/discount |
| `availableStock` | No longer independent state | Not present in current `LineItem` | stock projection | `inventory` render lookup | inventory load | Previously caused stale/zero snapshot risk; current code derives at render |

### Effects and overwrite relationships

- Mount effect invokes `loadMasterData()` and writes parties, inventory, color map, unique products, voucher IDs, and number.
- Voucher effect waits for master-data promise, then `loadVoucher()` writes header and line items.
- Party effect writes balance and balance limit only.
- Selected-color effect reads `tplColorId`, calls `getSaleableVariant()`, and writes selected variant/error.
- Price effect reads selected variant and writes `tplPairRate`.
- Discount effect reads party, selected variant, and pair rate and writes discount/source.
- Product/color handlers write selection IDs.
- Add/reset/navigation handlers can write pair rate and pair discount to zero.
- The current selected-color effect does not clear `selectedVariant` before the asynchronous read. A failed read clears it; a successful read replaces it.

## 11. Async and Race Conditions

| Operation | Reads | Writes | Out-of-order risk |
|---|---|---|---|
| `loadMasterData()` | parties, products, inventory, vouchers | parties, inventory, colorMap, uniqueProducts, voucher navigation | Promise is shared for initial voucher load; repeated calls are not globally deduplicated |
| `loadVoucher()` | voucher API and current allIds | header, lineItems, active ID, index | Navigation calls can overlap if user clicks rapidly; no request token beyond loading flag |
| `getSaleableVariant()` effect | `tplColorId` | selectedVariant/error | Uses cancellation flag; stale response is ignored. Current variant is retained while new request is pending |
| `resolveProductDiscountWithPrice()` effect | party, selected variant, pair rate | tplPairDisc/source | Uses cancellation flag; stale response ignored. A price edit triggers new resolution |
| `listInventory()` | SQLite product/stock join | inventory and colorMap through master load | Can be stale relative to production/dispatch because no live subscription is shown |
| `listProducts()` | SQLite grouped product query | uniqueProducts and colorMap fallback | Representative row may not be the selected color |
| party credit calls | party ID | balance/limit | No cancellation flag; changing parties quickly can show prior party balance if responses finish out of order |
| save/add line calls | lineItems and totals | DB voucher/lines and then UI resets/reloads | Sequential add loop; partial persistence is possible if a later line add fails |

No `setTimeout()` is used for the core stock/price/discount calculation. The page does use short focus timers after color selection/add, but those timers do not calculate business values.

## 12. Data Duplication and Source-of-Truth Matrix

| Business fact | Copies found | Canonical source | Main risk |
|---|---|---|---|
| Variant identity | product ID, color-map product ID, selected variant ID, line item ID, QR/product event IDs | `product_variants.id` | Representative row or natural-key reconstruction |
| Article/size | product variant columns, grouped product row, color-map key, line snapshot | Selected `product_variants` row for item facts | Grouping key mistaken for identity |
| Color | product variant, inventory row, color map, color option, selected variant, line snapshot | Selected variant `product_variants.color` | Sentinel/format values and display filtering |
| Selling price | product variant, inventory row, ProductRow, selected variant, template rate, line unit price | `product_variants.selling_price` before user override; line unit price after save | Stale/representative price or manual override |
| Stock | stock projection, inventory row, selected variant, rendered line lookup | `stock_projection_by_variant.quantity_on_hand` | Stale UI snapshot |
| Discount | rule tables, UI pair discount, line total discount, line discount per pair/source | Rule tables + backend resolver; saved line is historical snapshot | UI/backend double resolution |
| Party balance | sales/cash SQL aggregate, ledger response, renderer balance | SQL aggregate over active non-deleted records | Async display staleness |
| Party limit | party row, renderer limit, backend limit check | `parties.balance_limit` and backend check | UI is advisory only |

## 13. Sequence Diagram

```mermaid
sequenceDiagram
    actor User
    participant React
    participant Preload
    participant IPC as Electron IPC
    participant Main as Electron Main
    participant Data as SqliteDatabase
    participant DB as SQLite

    User->>React: Select party
    React->>Preload: getParty / getCustomerLedgerWithCash
    Preload->>IPC: invoke channels
    IPC->>Main: handler calls
    Main->>Data: party and ledger queries
    Data->>DB: SELECT parties, sale_vouchers, cash_vouchers
    DB-->>Data: rows
    Data-->>React: balance and limit

    User->>React: Select product/article-size
    React->>Preload: listProducts + listInventory already loaded
    React->>React: build display group/colorMap

    User->>React: Select GREEN color
    React->>Preload: getSaleableVariant(variantId)
    Preload->>IPC: invoke erp:get-saleable-variant
    IPC->>Main: handler
    Main->>Data: exact variant + stock query
    Data->>DB: product_variants JOIN stock_projection_by_variant
    DB-->>React: selectedVariant
    React->>React: set pair rate from sellingPrice

    React->>Preload: resolveProductDiscountWithPrice(partyId, variantId, price)
    Preload->>IPC: invoke discount channel
    IPC->>Main: handler
    Main->>Data: resolveProductDiscountWithPrice
    Data->>DB: variant metadata + discount hierarchy queries
    DB-->>React: discountPerPair/source

    User->>React: Enter dozen quantity
    React->>React: calculate dozen rate, gross, discount, total

    User->>React: Click Create
    React->>Preload: createSaleVoucher(projectedTotal)
    Preload->>IPC: invoke create channel
    IPC->>Main: handler
    Main->>Data: balance-limit validation and sale header insert
    Data->>DB: parties/sales/cash SELECT; sale_vouchers INSERT
    Main-->>React: voucher ID

    loop each line
        React->>Preload: addVoucherLineItem(variantId, quantity, unitPrice, discount)
        Preload->>IPC: invoke add-line channel
        IPC->>Main: handler
        Main->>Data: resolve discount + insert line + totals
        Data->>DB: variant/rule SELECT; line INSERT; voucher UPDATE
    end

    React->>React: refresh voucher list/reset form
```

## 14. File Map

| File | Purpose | Important functions | Tables/consumers |
|---|---|---|---|
| `apps/desktop/src/main.ts` | Electron runtime and IPC | `initializeServices`, `registerIpcHandlers` | All exposed SQLite/data methods; renderer consumers |
| `apps/desktop/src/preload.cts` | Context bridge | `contextBridge.exposeInMainWorld` | IPC channels; renderer |
| `apps/desktop/src/renderer/hooks/useDesktopApi.ts` | API hook | `useDesktopApi` | All renderer pages |
| `apps/desktop/src/renderer/types/desktopApi.ts` | Renderer contracts | `DesktopApi`, `InventoryRow`, `SaleableVariant`, voucher types | Renderer compile boundary |
| `apps/desktop/src/renderer/pages/SaleVoucherFormPage.tsx` | Sale form | `loadMasterData`, `loadVoucher`, variant/price/discount effects, `addItem`, `save` | Parties, products, inventory, vouchers, discount IPC |
| `apps/desktop/src/renderer/pages/SaleVoucherFormPage.test.tsx` | Form regression tests | selection, stock, price, discount, color tests | Mocked Desktop API |
| `apps/desktop/src/renderer/app/App.tsx` | Route/page composition | route switch | Sale Voucher page consumer |
| `packages/data/src/sqliteDatabase.ts` | SQLite adapter and business persistence | `listProducts`, `listInventory`, `getSaleableVariant`, `resolveDiscount`, voucher/ledger/cash/stock methods | All local tables |
| `packages/data/src/local-schema.sql` | Current local schema | CREATE TABLE/INDEX statements | SQLite |
| `migrations/sqlite/001_initial_schema.up.sql` | Declared baseline migration | Placeholder only | Not a complete baseline |
| `migrations/sqlite/002_variant_relationships.up.sql` | Variant relationship migration | ALTER TABLE/indexes | `product_variants` |
| `packages/data/src/sqliteDatabase.test.ts` | Data and integration tests | scan, stock, discount, voucher, ledger, balance limit | Temporary SQLite databases |
| `packages/application/src/processScanUseCase.ts` | Production scan orchestration | parse, duplicate check, variant create, event, stock increment, outbox | Ports implemented by data |
| `packages/application/src/dispatchScanUseCase.ts` | Dispatch orchestration | QR lookup, allowance, stock decrement, event/outbox | Dispatch/stock tables |
| `packages/application/src/returnScanUseCase.ts` | Return orchestration | return validation, stock increment, event/outbox | Return/stock tables |
| `packages/application/src/ports.ts` | Application/data contracts | transaction, catalog, stock, QR, outbox ports | Data adapter |
| `packages/domain/src/qr.ts` | QR parser | `parseQrCode`, parser registry | Production/dispatch/return consumers |
| `packages/sync/src/outboxSync.ts` | Intended cloud sync service | `runOnce` | Current stub; outbox integration not verified |
| `supabase/schema.sql` | PostgreSQL baseline | tables, triggers, RLS | Cloud schema; current business sync not verified |
| `apps/desktop/src/renderer/pages/InventoryPage.tsx` / `StockPage.tsx` | Inventory display | `listInventory` | Stock projection and product variant |
| `apps/desktop/src/renderer/pages/DiscountPolicyPage.tsx` | Rule management | list/create discount rule calls | Discount policy tables |
| `apps/desktop/src/renderer/pages/CustomerLedgerPage.tsx` | Ledger display | customer ledger APIs | Sale/cash voucher tables |
| `apps/desktop/src/renderer/pages/LiveProductionPage.tsx`, `LiveDispatchPage.tsx`, `LiveReturnPage.tsx` | Operational scanner UIs | process/dispatch/return APIs | QR/events/stock/outbox |

## 15. Current Risks

### CRITICAL

1. **Local and Supabase business schemas diverge.** The local schema has parties, discounts, sales, dispatch sessions, and cash vouchers that are absent from the inspected Supabase schema. Cloud durability/replication for these modules is **NOT VERIFIED FROM CURRENT CODEBASE**.
2. **Migration history is incomplete.** Migration 001 is a placeholder while startup executes the full local schema directly. Existing production upgrade history cannot be reconstructed solely from the migration directory.
3. **Frontend/backend discount disagreement is possible.** UI resolution and backend persistence resolution occur separately; the UI-provided total discount can coexist with backend-derived source/per-pair metadata.

### HIGH

1. **Representative product query is lossy.** `listProducts()` groups by article and size and uses `MIN(...)` values. A representative row can contain metadata from a different color than the selected variant.
2. **Multiple async party balance calls have no cancellation token.** Rapid party changes can display a previous party's balance/limit after a late response.
3. **Voucher save is multi-step.** Header creation and each line insertion are separate IPC calls. A later line failure can leave a partially populated draft voucher.
4. **Price and stock are duplicated in renderer caches.** `inventory`, `selectedVariant`, and line snapshots can differ in time.
5. **Price-range and other resolver queries use `LIMIT 1` without `ORDER BY`.** If data violates intended uniqueness or overlapping ranges exist, SQLite's selected row is not deterministic.

### MEDIUM

1. **Color sentinel handling is application-level.** The schema permits any non-null color string, including `N/A`; filtering must remain consistent across all data entry paths.
2. **Natural-key normalization is not globally demonstrated.** QR parser and product creation normalize/expect uppercase patterns, while UI/database reads may preserve existing values. Exact normalization policy across all historical data is **NOT VERIFIED FROM CURRENT CODEBASE**.
3. **Stock shown in the renderer is a snapshot.** Production/dispatch/return activity after master load does not automatically refresh the Sale Voucher page.
4. **`getSaleableVariant()` treats non-positive price as unusable in UI.** A legitimate zero price is not a saleable pair rate under current validation, but the business policy is **NOT VERIFIED FROM CURRENT CODEBASE**.
5. **Soft-delete and status are separate dimensions.** Some queries filter status, some only deleted state, and inconsistent use could expose disabled or historical records.

### LOW

1. Debug `console.log` statements remain in discount resolution and can expose operational rule inputs in logs.
2. Supabase has placeholder RLS policies rather than demonstrated complete authorization policies.
3. Audio tests emit jsdom `HTMLMediaElement.play` warnings; this does not currently fail the suite.
4. `@erp/sync` reports zero work without a real sync implementation.

## 16. Verified Current Sale Voucher Model

```text
Display selection
  uniqueProducts (article + size grouping)
        |
        v
colorMap (article + size -> actual variant IDs)
        |
        v
 tplColorId = product_variants.id
        |
        v
getSaleableVariant(id)
        |
        +--> article, size, color
        +--> selling_price -> tplPairRate
        +--> quantity_on_hand -> current stock read
        +--> article_series_id / product_group_id
        |
        v
resolveProductDiscountWithPrice(partyId, id, pairRate)
        |
        v
 discountPerPair/source
        |
        v
lineItems draft
        |
        v
createSaleVoucher(projectedTotal)
        |
        v
sale_vouchers + dispatch_sessions
        |
        v
addVoucherLineItem()
        |
        +--> backend discount resolution
        +--> sale_voucher_line_items snapshot
        +--> voucher totals
        |
        v
ledger and dispatch consumers
```

### Canonical source-of-truth statement

- **Variant identity:** `product_variants.id`.
- **Article, size, color:** selected `product_variants` row by ID.
- **Pair Rate:** selected variant `product_variants.selling_price`, except a user-edited unsaved template or saved transaction unit price.
- **Current stock:** `stock_projection_by_variant.quantity_on_hand` joined by variant ID.
- **Article Series:** selected variant `article_series_id`; series name from `article_series`.
- **Product Group:** selected variant `product_group_id`; group name from `product_groups`.
- **Discount:** active rows in party discount tables, selected by the backend hierarchy.
- **Party balance:** aggregate of active/non-deleted sale and cash vouchers.
- **Party balance limit:** `parties.balance_limit`, enforced by backend sale-voucher creation.
- **Historical sale values:** saved `sale_voucher_line_items` snapshots.
- **Cloud copy of sales/parties/discounts:** **NOT VERIFIED FROM CURRENT CODEBASE**.

ARCHITECTURE AUDIT COMPLETE
FILES MODIFIED: NONE
CODE MODIFIED: NONE
