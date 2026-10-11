# Phase 1a — migration and rollback plan

> Written 2026-10-10. Implementation is complete and rehearsed on disposable databases only.
>
> **DEPLOYMENT IS BLOCKED.** Whether the production database contains duplicate raw-material
> session numbers is **UNKNOWN — NOT CHECKED**. Migration 061 fails safely if duplicates
> exist, but because migrations run automatically at startup, that failure would stop the ERP
> opening. The preflight in §3 must be run by an authorised operator on a verified restored
> backup before this is deployed anywhere.

## 1. What changed and why

| File | Change | Why |
|---|---|---|
| `migrations/sqlite/061_rm_session_number_unique.up.sql` | **new** — two `CREATE UNIQUE INDEX` statements | `raw_material_receiving_sessions.session_number` and `raw_material_issue_sessions.session_number` had no uniqueness. Their siblings `store_receiving_sessions` / `store_move_out_sessions` (migrations 024, 025) have `UNIQUE`; migrations 038 and 039 omitted it for the identical column. A duplicate would be accepted **silently**, unlike every other numbered document. |
| `migrations/sqlite/061_rm_session_number_unique.down.sql` | **new** — two `DROP INDEX` | Reversal. Drops only those two indexes. |
| `packages/data/src/database/sales.ts` | `createSaleVoucher`: number block moved inside `BEGIN IMMEDIATE` | The number was read ~30 lines before the write lock opened. A supplied `input.voucherNumber` still wins — the office numbers its own bills from the paper book. |
| `packages/data/src/database/purchases.ts` | `createPurchaseVoucher`: allocation moved inside the transaction (`let` + assign, because the return is outside the `try`) | Same race. |
| `packages/data/src/database/removalRequests.ts` | `createCategoryRemovalRequest` and `createItemRemovalRequest`: `DEL-` allocation moved inside | Same race, two paths. |
| `packages/data/src/database/stockCorrections.ts` | `createStockCorrectionRequest`: `SCR-` allocation moved inside | Same race. |
| `packages/data/src/database/parties.ts` | `createParty`: wrapped in `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` | Had **no transaction at all**. `party_code` is UNIQUE, so allocation and insert must be one unit. |
| `packages/data/src/numberAllocationAtomicity.test.ts` | **new** — 7 tests | Format preservation and `createParty` atomicity. |

**Deliberately NOT changed**, per the approved scope:

- `raw_material_qrs` — already has `UNIQUE(party_id, item_id, sequence)`.
- `insertInventoryItem` (`rawMaterials.ts:441`) — already inside a transaction in **both** callers (`rawMaterials.ts:500` under `BEGIN` at :498, and `inventoryImport.ts:269` under `BEGIN` at :265). Adding one would raise a nested-transaction error.
- `createWorkSection` — deferred. Called both inside a transaction (`machinePrograms.ts:175` → `defaultMachineSectionId` at :185) and from IPC with none (`ipc/rawMaterials.ts:37`). Needs a `SAVEPOINT` or caller-side change.
- **Product-code allocation — deferred to Phase 1d.** `ProductFormPage.tsx:187` prefills the code, `:383` sends it back on save, `ipc/products.ts:103` forwards it, and `products.ts:255` uses `input.productCode ?? this.getNextProductCode()`. Two product forms open at once therefore receive the same code and the second save fails on the unique index. This is a **cross-IPC time-of-check/time-of-use**, not a transaction-boundary problem, and no change here fixes it. It is a loud failure, not corruption.

## 2. Known risk accepted in this phase

Product code conflict, as above: a user may see *"UNIQUE constraint failed: article_sizes.product_code"* when two product forms are open simultaneously. Pre-existing, unchanged by Phase 1a, scheduled for Phase 1d.

## 3. Preflight — to be run by an authorised operator, on a VERIFIED RESTORED BACKUP

**Never run these against the live file.** Restore the most recent verified backup to a separate folder first, confirm `PRAGMA integrity_check` returns `ok`, then run:

```sql
SELECT session_number, COUNT(*) AS n
FROM raw_material_receiving_sessions
GROUP BY session_number HAVING n > 1;

SELECT session_number, COUNT(*) AS n
FROM raw_material_issue_sessions
GROUP BY session_number HAVING n > 1;
```

**Both must return zero rows.**

### If either returns rows — STOP

Do not deploy. Do not renumber, merge or delete anything: these numbers are shown to operators as `RMI-000006` / `RMO-000006` and may appear on paperwork. Capture the duplicate rows (`id`, `session_number`, `started_at`, `device_id`, `status`) and bring them back for a decision. Options would then be to scope the index differently or to correct the data deliberately — both require explicit approval.

## 4. Deployment sequence (only after a clean preflight)

1. Close the ERP.
2. Take a backup with the verified `VACUUM INTO` procedure. Confirm `integrity_check = ok` and that table counts match the live file.
3. Deploy the new build. Migration 061 runs automatically at first launch.
4. Confirm startup: no `startup.log`, `schema_migrations` contains `061_rm_session_number_unique`, both indexes exist and are `UNIQUE`.
5. Smoke-test: open and close one raw-material receiving session and one issue session; confirm `RMI-`/`RMO-` codes still increment normally.

## 5. Recovery

| Situation | Action |
|---|---|
| Migration fails at startup | **Nothing was written** — the whole run is one transaction and 061 is not recorded. Restore the previous build. The database is untouched and the old build runs against it unchanged. |
| Need to undo after a successful migration | Apply `061_..._down.sql` manually (`DROP INDEX` ×2). Reversible, unlike a `DROP COLUMN` migration. The application does not execute `.down.sql` files. |
| Something else wrong | Restore the pre-migration backup. |
| Code-only rollback | Revert the six touched data-layer functions. They carry no schema dependency. |

A failed migration leaves the ERP unable to start — which is why §3 is mandatory, not advisory.

## 6. Rehearsal evidence (disposable databases, 2026-10-10)

26 checks, all passed. No production data involved.

| Scenario | Result |
|---|---|
| Clean DB (001–060 + synthetic sessions) | 061 applies; both indexes created and `UNIQUE`; recorded in `schema_migrations`; all rows unchanged; `raw_material_qrs` indexes untouched; `integrity_check ok`; 0 FK violations |
| Duplicates seeded | Migration **fails** with `UNIQUE constraint failed: raw_material_receiving_sessions.session_number`; **no index created**; 061 **not** recorded; every row unchanged; duplicates still present — nothing renumbered, merged or deleted |
| Failure on the **second** statement only | **First index rolled back as well**; 061 not recorded; rows unchanged |
| `.down.sql` on a migrated DB | Both indexes dropped; nothing else touched; `integrity_check ok` |

## 7. Test results

```
npm run build                                    PASS, 0 TypeScript errors
@erp/domain       54 / 54          baseline 54 / 54            unchanged
@erp/scanner       3 / 3           baseline  3 / 3             unchanged
@erp/application  66 / 67, 1 fail  baseline 66 / 67, 1 fail    unchanged
@erp/data        422 / 429, 7 fail baseline 415 / 422, 7 fail  +7 tests, +7 pass, failures unchanged
@erp/desktop     413 / 440, 27 fail baseline 413 / 440, 27 fail unchanged
```

The 7 `@erp/data` failures were listed by name and match the documented baseline exactly. **No new failures.** Phase 0 suites intact: 14 `deviceIdentity`, 5 `cashVoucherAtomicity`. The existing `categoryRemoval` (11), `itemRemoval` (9) and `stockCorrection` (8) suites — which exercise the exact creators edited here and assert `/^DEL-\d{6}$/` and `/^SCR-\d{6}$/` — all pass.

## 8. Still required before deployment

1. **Preflight on a restored backup** (§3) — the one blocking unknown.
2. A verified pre-migration backup (§4.2).
3. Multi-process concurrency testing. Phase 1a closes the read/insert window; it does not prove behaviour under two simultaneous writers, which cannot happen today (single process, single-instance lock) and is a Phase 1d concern.
