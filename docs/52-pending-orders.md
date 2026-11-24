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
| Customer order | `customer_orders` + `customer_order_lines` | ORDERS (since 24 Nov 2026, cloud 042; SALES_DISPATCH before) | A line names a live `product_variants` row. Never deleted: an edit marks a line REMOVED. |
| Gatepass allocation | `gatepass_order_allocations` + `gatepass_order_allocation_lines` | SALES_DISPATCH | One per gatepass (UNIQUE `gatepass_id`). A reversed line keeps its quantity and gets `reversed_at`. |

Both are 013 leased records, sent whole by revision. A receiver writes them as they come: no computer but the one that
made the gatepass ever works an allocation out.

**Since 24 Nov 2026 (owner; cloud 042) orders have their own lease, ORDERS, held by the boss's computer, PC3.**
Gatepasses and their allocations stay on PC1 under SALES_DISPATCH. The trade, accepted by the owner: an order entered on
PC3 reaches PC1 at the next sync, and a gatepass made on PC1 before it arrives does not count against it (no allocation
is worked out again); PC3 sees dispatches with the same delay. Pending never goes below zero. Before that, orders were
written only where SALES_DISPATCH was held, so a gatepass always allocated against every order there was.

**When an edit on PC3 crosses a gatepass on PC1.** Both computers work offline, so a reduction, removal or cancellation
typed on PC3 can meet a gatepass PC1 has already counted against the same line. Neither computer, nor the cloud while
the gatepass is still on PC1, can refuse what it has not received. The rule every computer applies, from the rows it
holds, whatever order they arrived in (`ORDER_LINE_EFFECTIVE_SQL`, `orderAllocation.ts`):

- a line goes on counting once anything was dispatched against it, even if it was later taken off the order;
- what it orders is `MAX(quantity asked, dispatched)`; a line taken off orders exactly what was dispatched;
- the quantity asked is kept and shown beside it ("asked 2"), so the crossing is visible, never silent;
- pending is never below 0, and no allocation is ever reversed, hidden or recounted by this.

A cancellation closes the order (nothing pending) and keeps every line and dispatch. PC3 still refuses, in its own write
transaction, a reduction below what it already knows was dispatched. The race cases are proved across three simulated
computers in `packages/sync/src/customerOrderSync.test.ts` (both arrival orders, removal, cancellation, replay, retried
Save, several edits before a sync, and an order written on PC1 never reaching the cloud).

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
