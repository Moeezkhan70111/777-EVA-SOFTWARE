# 52 — Customer orders and Pending Orders

**Date:** 2026-11-17
**Status:** Built on `feat/pending-orders` (worktree `C:\Projects\777-pending-orders`, branched from `feat/carton-stock` at
46a896b, v0.5.13). Uncommitted. Local migration 112. Cloud migration 036 **prepared, not applied** to TEST or PRODUCTION.

```
Enter Orders ─▶ ORD-000014 (party, lines: article + colour + size, cartons)          moves nothing
Gatepass made ─▶ its lines counted against the party's open orders, oldest first     same transaction as the gatepass
Gatepass cancelled ─▶ exactly that allocation reversed                                same transaction as the cancel
Pending = ordered − allocated (not reversed), never below zero                        computed, never stored
```

## 1. Records

| Record | Tables | Lease | Notes |
|---|---|---|---|
| Customer order | `customer_orders` + `customer_order_lines` | SALES_DISPATCH | A line names a live `product_variants` row. Never deleted: an edit marks a line REMOVED. |
| Gatepass allocation | `gatepass_order_allocations` + `gatepass_order_allocation_lines` | SALES_DISPATCH | One per gatepass (UNIQUE `gatepass_id`). A reversed line keeps its quantity and gets `reversed_at`. |

Both are 013 leased records, sent whole by revision. A receiver writes them as they come: no computer but the one that
made the gatepass ever works an allocation out. Orders are written only where SALES_DISPATCH is held (the computer that
makes gatepasses), so a gatepass always allocates against every order there is.

## 2. Allocation rules (`orderAllocation.ts`, `allocateFifo` in `@erp/domain`)

- Match: same party, same product (article + colour + size, i.e. the same `product_variant_id`), OPEN order, ACTIVE line.
- FIFO: oldest order first (`created_at`, then number, then line). Each line takes at most what it still owes.
- Over-dispatch: what no line is owed is recorded as `unallocated_quantity` and in the audit row. Pending never goes below 0.
- A gatepass whose party has no matching order writes no allocation at all.
- Idempotent: a retried Create returns the gatepass already made before allocating (request id, migration 105); a second
  allocation of the same gatepass returns the first; reversing twice reverses once.
- Nothing else moves: no stock, money, bill, ledger or gatepass field. `customerOrders.test.ts` checks that a gatepass
  against an order changes stock, bills and cash exactly as one without.

## 3. Orders

- Save: party active, every line a live product, whole cartons 1–100,000, no duplicates, at most 600 lines. The request id
  is the order's id, so a retried Save returns the same order (a different body under the same id is refused).
- Edit (revision-checked): quantities, products added or taken off. Refused: a line below what was dispatched, taking off
  a dispatched line, changing the party of a dispatched order.
- Cancel (revision-checked, reason required): status CANCELLED; nothing pending; what was dispatched stays recorded.
- Every write leaves an `audit_log` row (ORDER_CREATED, ORDER_EDITED with before/after, ORDER_CANCELLED, ORDER_ALLOCATED,
  ORDER_ALLOCATION_REVERSED, ORDER_REALLOCATED).

## 4. Gatepass edits

**There is no Gatepass edit in the system today.** A gatepass is made and may be cancelled (then its bill if unentered);
nothing changes its lines. `reallocateGatepassOrders` is the one call an edit must make, inside its own transaction: it
reverses the active allocation and allocates again from the gatepass's lines as they then stand, or only reverses when the
gatepass is cancelled. It is tested (atomic: a failed edit leaves the allocation as it was) but not wired to any screen.

## 5. Permissions

Three new codes, granted to nobody by migration. Administrators hold them; anyone else is given them in Profile & Roles.

| Code | Allows |
|---|---|
| `orders-enter` | Enter Orders page; save and edit orders |
| `pending-orders` | Pending Orders page (read) |
| `orders-cancel` | Cancel an order |

The main process checks each one (`main/ipc/customerOrders.ts`); the screens only decide what is offered.

## 6. Deployment order

1. Apply cloud 036 to the project the release talks to **before** the computer holding SALES_DISPATCH runs a release with
   local 112. Until then orders and allocations wait in the outbox as UNKNOWN_RECORD_TYPE; gatepasses, bills and stock are
   not held up (`customerOrderSync.test.ts`).
2. Local 112 sits between 111 (the ledger archive, [50](50-historical-ledger-archive.md)) and 113 (supplier archives and
   opening balances, [53](53-supplier-archive-and-opening-balances.md)). Its outbox rebuild allows LEDGER_ARCHIVE_STATEMENT
   and PARTY_OPENING_BALANCE as well as its own two types, and 113's allows 112's, so a computer can meet 112 and 113 in
   either order. Cloud 034, 035 and 037 belong to that work. 036 needs none of them.
3. Existing gatepasses are not allocated backwards: an order counts the gatepasses made after it.
