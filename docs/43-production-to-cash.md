# 43 — The manual production-to-cash workflow, on every computer

**Date:** 2026-11-07
**Status:** Built on `feat/carton-stock`, uncommitted. Cloud migration 028 applied to TEST only. Not on production.
**Builds on:** docs/42 (carton stock movements), docs/37 §W (single writer per domain), cloud 013 (leased records).

```
Machine + product + dozens ─▶ Manual Production entry ─▶ +cartons (movement)      ─▶ Contractor Ledger (computed)
Gatepass ─▶ −cartons (movement, once) ─▶ one generated bill, no lines, no money
Bill entry (all lines at once) ─▶ customer debit = the bill's total
Cash voucher ─▶ customer credit
```

## 1. What travels, and under whose lease

| Record | Tables | Lease | Notes |
|---|---|---|---|
| Product master | `main_groups`, `product_groups`, `article_series`, `product_types`, `product_sub_groups`, `article_sizes` + `product_variants` | MASTER_DATA | Prices and contractor rates travel now (017 kept them out). Pictures do not. |
| Manual Production entry | `manual_production_entries` | CARTON_STOCK | Stands on its own: see section 2. `machine_program_id` never travels. |
| Carton movement | `carton_stock_events` | CARTON_STOCK | docs/42, unchanged. |
| Gatepass | `gatepasses` + `gatepass_lines` | SALES_DISPATCH | Making and cancelling one also needs CARTON_STOCK. |
| Bill | `sale_vouchers` + `sale_voucher_line_items` + `dispatch_sessions` | SALES_DISPATCH | One domain with the gatepass: a bill is locked to it. |
| Cash voucher | `cash_vouchers` + `cash_voucher_lines` | ACCOUNTS | |

All of them are 013 leased records: captured by triggers (`masterCapture.ts`), sent whole by revision through
`push_leased_record`, applied by the generic contract. The cloud checks the device's claim and the type's lease; a
repeat is DUPLICATE, other content under one revision is REVISION_CONFLICT. Nothing is merged.

**Not travelling (stated so nobody assumes otherwise):** machine programs and their children, party claims, purchase
vouchers, sale returns, customer discount rules, delivery photos, product pictures.

## 2. A Manual Production entry stands on its own (local migration 104)

Machine programs do not travel, and a program has a life on the store computer that a production computer must never
overwrite. So an entry carries `program_ref`, `program_number`, `machine_name`, both contractors, and the rates copied
when it was saved (`machine_rate_paisa`, `packing_rate_paisa`, `printing_rate_paisa`, `rate_source`).

- **Rate copy:** the program's agreed rate for the product, else Add Product's standard. A later price change does not
  rewrite earnings. A job with no copied rate (every entry from before 104, or work nobody priced) is priced the old
  way, live. Nothing is invented for old entries.
- **Contractor Ledger:** reads the entry's own contractors and rates. Work lines are grouped by rate too, so one day's
  work at two rates is charged at each.
- **Exactly once:** the ledger is computed from the entry, never stored apart, so it cannot disagree with the entry.

## 3. Gatepass and bill

- Making a gatepass takes its cartons out (docs/42) **and** makes its one bill in the same transaction: a number, the
  link, no lines, no money. The unique index on a live bill per gatepass makes a second one impossible.
- **Bill entry** (`enterGatepassBill`): every line at once, checked against the gatepass, under the balance limit, in
  one transaction. Entering it again changes nothing (`duplicate`). This moves the gatepass to BILLED. No stock moves.
- A line cannot be added to a generated bill one at a time. `createSaleVoucher` for that gatepass takes up the generated
  bill instead of making a second.
- **Cancelling a gatepass** puts its cartons back once and cancels its bill if nobody entered it. An entered bill must
  be deleted first, as before. Deleting a bill removes its debit and returns the gatepass to CREATED. It does not return
  stock: the gatepass still holds the cartons until it is cancelled.
- A generated bill with no lines is not a ledger line (`total_amount_paisa <> 0`).

## 4. Customer balance, one rule

A cash voucher counts for a party through **its own lines** when the voucher has lines, else through the header. The
ledger and the limit check already did this. The balance list read headers only, which left every party but the first
on a multi-line voucher out. Fixed. The ledger's in-period rows had the same gap for a party named only on a line. Fixed.

A Save pressed twice on a cash voucher is one voucher: the screen's request id is the voucher's id.

## 5. Offline, refused, and handed over

- Offline, the holder keeps working. Marks wait. On reconnect they go, once.
- Work refused `NOT_LEASE_HOLDER` (made while the lease was lost) is resent as the same revision when the lease comes back
  (`resendCartonMovementsRefusedForLease` now covers the four document types too).
- The backfill marks each record type under its own lease's epoch, and skips a type whose lease is not held here.

## 6. Screens

`DATA_KIND` gains PRODUCTS, BILLING, CASH. Carton movements and entries are CARTONS. The gatepass grid, gatepass list,
sale voucher list, customer ledger, customer balance, cash voucher list and contractor ledger reload when such work
arrives. Customer and contractor ledgers now show on every computer. Supplier ledgers stay on the Accounts holder.

## 7. Evidence (2026-11-07)

Automated: `packages/sync/src/productionToCash.test.ts` (simulated cloud, real everything else).

**Real two-PC rehearsal on TEST** (`wpkrhgqsizjjdaztijwv`), from disposable copies `C:\erp-wf-w1` (dev-gate-holder) and
`C:\erp-wf-w2` (9f4c61aa…), the real app built from this branch:

| Step | Result |
|---|---|
| W1 sends 22 product records | W2 0 → 15 products, 36 colours linked |
| Production 10 dozen on W1 | 20 cartons, rates 7000/7500 copied; on W2 at once |
| Gatepass for 21 | refused, In Store 20 |
| Gatepass for 6 | stock 14, bill 1 generated at Rs 0; on W2 after 2.1 s |
| Bill entered on W1's real bill screen | Rs 16,920; W2's open Sale Vouchers screen updated by itself |
| Cash Rs 5,000, Save pressed twice | one voucher; W2's open Customer Balance showed 11,920 after 3.0 s |
| W2 tries every write without leases | all refused by the lease gate, nothing written |
| Same pushes at the cloud as W2 | NOT_LEASE_HOLDER; W1 repeat DUPLICATE; other content REVISION_CONFLICT (rolled back) |
| Handover to W2 | W2 writes after 15 s; W1 refused; same fingerprint ecb204bb6b401cdf |
| Cancel, delete, void on W2 | stock back once; void refused when cartons had gone (names GP-000001); fingerprint d4ebc43fe81784ca |
| W2 offline, works, hard-killed, restarted, reconnected | nothing lost; converged 114 s after reconnect; fingerprint 5f58db5adaa9a890 |
| W1's open gatepass row | 28 → 30 by itself, 3.0 s after W2 produced |
| Raw material on both | five tables byte-identical before and after |

## 8. Open

- Production needs 026, 027 and 028 applied, and every computer on this build, before any of this is switched on.
- Old bills and cash vouchers on PC2/PC3 travel only through the backfill, which stops while raw material does not add
  up (Repair A).
- No manual stock return path exists: returns are QR-only and on hold.
- Discount rules, party claims and machine programs do not travel.
- The "next number" previews on the gatepass and bill screens count other computers' numbers. The number actually given
  is always from this computer's own block.
