# 42 — Carton stock, replicated

**Date:** 2026-11-03
**Status:** Planned. Not started.
**Owner decision (2026-11-03):** cartons enter stock through Manual Production and leave through
a **gatepass**. Stock falls **when the gatepass is made** — dispatch cannot be tracked today, so
there is no later stage to settle against. Carton QR work is on hold and is not part of this plan.
**Goal:** every PC, including the boss's read-only PC, shows the same accurate carton stock.

**Ships after:** PC2's production cutover, and after the cloud-accounts release (`docs/41 §12`).
See §8. **Blocked on one check:** carton stock must be confirmed empty **on PC2** before this
ships — see §4, which §5 now gives a clean way to settle.

---

## 1. Why this is not a small change

The local arithmetic is small. The problem is that neither side of the carton figure travels.

| | Today | Consequence |
|---|---|---|
| Manual Production | writes `stock_projection_by_variant` and the WAREHOUSE row of `stock_projection_by_location` directly, in its own transaction | the projections are **derived** tables and never replicate (`docs/38 §1`), so no other PC learns those cartons exist |
| Gatepass | explicitly on the **does not replicate** list (`docs/38 §1`) — one of the hard conflict cases | no other PC learns the cartons left |
| Carton QR | `qr_master` and `production_events` **do** replicate | the QR path would work, but it is on hold |

So making the gatepass decrement stock, on its own, produces a figure that is right on the PC that
made the gatepass and **permanently zero everywhere else**. The boss's screen is the whole point,
so the movement itself has to become a replicating fact.

Raw material already solved exactly this problem. Cartons get the same treatment.

## 2. The precedent being copied

Raw material stock is accurate on every PC because:

1. every movement is an append-only row in `inventory_stock_events`, carrying `balance_delta` —
   the change the origin made;
2. that table replicates under aggregate type `STOCK_EVENT` (cloud migration 015), logged by
   `log_stock_event_insert`;
3. on arrival, `stockEventContract` (`packages/sync/src/stockEventContracts.ts`) inserts the event
   and moves the balance by `balance_delta` **in the same transaction**, and an event already here
   moves nothing — so at-least-once delivery cannot count a movement twice;
4. prerequisites that replicate are **waited** for; a reference that does **not** replicate is kept
   aside instead of blocking the event (`pending_machine_program_id`, migration 097).

Point 4 is the one that makes cartons possible at all: a gatepass never replicates, so the
receiving PC will never have the gatepass row. The event must carry the gatepass id as a
**reference only**, never as a prerequisite and never as a foreign key that must resolve.

## 3. What to build

### 3.1 Local table — `carton_stock_events`

```
id                          TEXT PRIMARY KEY
product_variant_id          TEXT NOT NULL  -> product_variants(id)
event_type                  TEXT NOT NULL  CHECK IN ('MANUAL_PRODUCE','GATEPASS_ISSUE','GATEPASS_CANCEL')
quantity                    INTEGER NOT NULL CHECK (quantity > 0)   -- cartons, always positive
balance_delta               INTEGER NOT NULL                        -- +produce, +cancel, -issue
created_by                  TEXT
created_at                  TEXT NOT NULL
origin_device_id            TEXT NOT NULL
replicated_at               TEXT                                    -- null on an event recorded here
manual_production_entry_id  TEXT                                    -- reference only, see below
gatepass_id                 TEXT                                    -- reference only, see below
gatepass_line_id            TEXT                                    -- reference only, see below
CHECK (abs(balance_delta) = quantity)
```

**The three source ids carry no foreign key and are never waited for.** They exist so a figure can
be traced back on the PC that made it. On any other PC they are dangling by design — the gatepass
and the manual production entry do not replicate. This mirrors `pending_machine_program_id`.
Do not add an FK, and do not add them to any `missing()` check.

`product_variant_id` **is** waited for: product master replicates (`docs/38 §1`).

### 3.2 Cloud table and aggregate type — migration 026

**Numbering, settled 2026-11-03:** cloud **025** is taken by `025_role_create_never_overwrites`
(the `admin_save_role` fix), which is already applied to test. Do not renumber it — renumbering a
migration that has been applied somewhere is how two projects drift apart. The carton cloud
migration is **026**. The local migration is unaffected and stays **101**.


Mirror `migrations/supabase/015_stock_events.up.sql` exactly:

- `public.carton_stock_events` with the same columns plus `received_at timestamptz default now()`
- RLS enabled, `revoke all ... from public, anon, authenticated`
- a new row in `sync_aggregate_types` for `CARTON_STOCK_EVENT`
- `log_carton_stock_event_insert()`, `security definer`, `set search_path = ''`, writing a
  `sync_event_log` row with dedupe key `'CARTON_STOCK_EVENT:' || new.id`

**Open, decide before writing:**

- **`factory_scoped`** — raw material's `STOCK_EVENT` is `false`; `PRODUCTION_PRODUCED` is `true`.
  A carton stock movement is a store fact, so `false` matches raw material. Confirm against
  the check constraint in `cloudSchema.test.ts` that pairs aggregate type with `factory_id`.
- **The advisory lock** — 015 takes `pg_advisory_xact_lock(777, 1)` to keep `sync_event_log`
  totally ordered. Check 016 and 018: if that lock is the log's single ordering lock, cartons must
  take **the same** one, not a new key.

### 3.3 The contract

`packages/sync/src/cartonStockEventContracts.ts`, modelled on `stockEventContracts.ts`:

- `missing()` — wait only for `product_variants`. Nothing else.
- `write()` — insert the event `ON CONFLICT(id) DO NOTHING`; **only if newly inserted**, apply
  `balance_delta` to both `stock_projection_by_variant` and the WAREHOUSE row of
  `stock_projection_by_location`. One helper, used by both the local writers and this apply path,
  so there is a single definition of "move the carton figure".
- `conflict()` — same id must be the same movement: same variant, type, quantity, time.
- applied with `withCaptureSuppressed` — a movement received is not this computer's to send.

**`stock_projection_by_variant.quantity_on_hand` has `CHECK (quantity_on_hand >= 0)`.** An arriving
issue event that would take it negative will **throw**. Under single-writer this cannot happen, so
it must not be clamped and must not be swallowed: park it as a wait with a named reason
(`CARTON_STOCK_WOULD_GO_NEGATIVE:<variantId>`) so it shows up in `report_sync_health` rather than
silently producing a wrong figure. A clamp here would be the carton equivalent of the PC2/PC3
incident — a number that looks fine and isn't.

### 3.4 The three local writers

**Manual Production** (`packages/data/src/database/manualProduction.ts`) — inside the existing
single `BEGIN IMMEDIATE` transaction, add one `MANUAL_PRODUCE` event, `balance_delta = +cartons`,
and move the projections through the shared helper instead of its own two statements. Its
idempotence rule stands: a Save retried with the same request id adds nothing, so it must not add
a second event either.

**Gatepass creation** (`packages/data/src/database/gatepass.ts`, the `BEGIN IMMEDIATE` block) — one
`GATEPASS_ISSUE` event per line, `balance_delta = −quantity`, projections moved through the same
helper. Keep the existing refusal when the store does not hold enough cartons; the DB check is the
floor, not the error message.

**Gatepass cancel** — one compensating `GATEPASS_CANCEL` event per line, `balance_delta = +quantity`.
Append-only: never delete or rewrite the issue events. Cancelling twice must not restore twice.

### 3.5 The part that will go wrong if it is missed

`RESERVED_FOR_VARIANT_SQL` in `gatepass.ts` currently computes, for every non-cancelled gatepass
line, `quantity − (cartons Store Move Out actually took)`, and `Reflected Stock = Current − Reserved`.

Once a gatepass takes its cartons out of Current Stock at creation, **that subtraction happens
twice** and Reflected Stock is wrong by the full gatepass quantity.

Under the owner's decision there is no gap between promising and issuing: a gatepass issues its
cartons the moment it is made, so nothing is ever outstanding. So:

- Reserved is **0**, and `Reflected Stock = Current Stock`. One figure.
- Collapse the two numbers in `packages/domain/src/gatepassStock.ts` and in every screen and query
  that reads them. The gatepass screen, the Stock screen and the dashboard all read the figure
  through `IN_STORE_STOCK_SQL`, so they come right on their own once Current Stock is the truth.
- Leave the scan-side attribution (`findOldestOutstandingGatepassLine`,
  `LINE_DISPATCHED_SQL`) in place but **unreachable for issued lines** — a line issued at creation
  is fully settled, so no future scan can be attributed to it. This is what stops carton QR, when
  it returns, from taking the same carton out twice.

Do not leave both subtractions live, and do not produce two behaviours by accident. One rule,
in one place, with a comment saying why.

## 4. Starting from zero — and the check that has to pass first

The owner reports carton stock is **empty** (2026-11-03). If that holds on every computer, there is
**no backfill**: the first replicated carton event is the first Manual Production entry made after
this ships, and every PC starts from the same zero. That removes the riskiest part of this plan.

**It has to be verified on PC2, not on the dev machine.** Two reasons:

1. `scripts/clear-test-state.mjs` states it explicitly — *"No business table is touched"*, and
   `verifyTestStateClear` proves it by counting every one. The cutover clears sync state only. Any
   carton stock in PC2's database today is still there afterwards.
2. **Deleting `manual_production_entries` rows does not remove their cartons from stock.** Manual
   Production moves the projections directly, with no event behind it, so there is nothing to
   reverse. The known test entries MP-000001/2/3/6 on PC2 each added cartons that outlive the row.

So before this ships, on PC2:

```sql
SELECT COALESCE(SUM(quantity_on_hand), 0) FROM stock_projection_by_variant;
SELECT COALESCE(SUM(quantity_on_hand), 0) FROM stock_projection_by_location
  WHERE location_type = 'WAREHOUSE';
SELECT COUNT(*) FROM manual_production_entries;
```

- **All zero** → delete §4. Nothing to carry, nothing to reconcile.
- **Not zero** → it is test-era data, so clear it rather than describing it: delete the manual
  production entries **and** zero the carton rows of both projections, in one transaction, as a
  named one-off script with a before/after count. Do not write opening events for test cartons —
  that makes test data permanent replicated history on every PC, forever.

If real carton stock ever exists before this ships, the backfill comes back and the rule is: one
`MANUAL_PRODUCE` event per existing entry at its original `created_at`, then the sum of events per
variant must equal the WAREHOUSE projection, and any difference gets an explicit opening event —
never a quiet adjustment. Precedent: `packages/data/src/database/backfill.ts` and
`packages/sync/src/backfill.ts`.

## 5. Undoing a manual production entry

**Owner requirement (2026-11-03):** deleting a manual production entry must remove its cartons
from stock.

### It is a void, not a delete

A hard delete cannot replicate. Every other PC has already applied the `MANUAL_PRODUCE` event and
raised its figure; deleting the row here sends nothing, so their figures stay wrong permanently. The
only thing that can undo a replicated movement is an opposite movement.

So: the entry is **kept and marked voided**, and a `MANUAL_PRODUCTION_VOID` event with
`balance_delta = −cartons` takes the cartons back out on every PC. The screen may still call the
button Delete; the record underneath is a void. This is the same shape as the compensating
`GATEPASS_CANCEL` event in §3.4, and the same rule as `manual_production_entries` being
"never changed afterwards" — it is not changed, it is superseded.

Add to the event type check: `'MANUAL_PRODUCTION_VOID'`.
Add to `manual_production_entries`: `voided_at TEXT`, `voided_by TEXT`, `void_reason TEXT`.
A voided entry is excluded from `listManualProduction`'s day totals and shown as voided in the list.

### Two refusals, both required

**The cartons must still be in the store.** If a gatepass has already issued them, voiding would
take the figure below zero — which `stock_projection_by_variant`'s `CHECK (quantity_on_hand >= 0)`
will refuse at the database level. Check it first and refuse with something the operator can act on:
*"These cartons have already gone out on gatepass GP-000123. Cancel that gatepass first."*
Compare against current stock for the variant, not against the entry's own quantity.

**A void happens once.** Voiding an already-voided entry must change nothing and emit no second
event, exactly like cancelling a gatepass twice.

### The contractor ledger — decided

Manual Production joins the machine's day program, and **the Contractor Ledger reads these entries**
(`manualProduction.ts` header).

**Owner decision (2026-11-03): a void withdraws the contractor ledger line as well. The entry is
treated as never produced.** Nobody is owed for cartons that were never made.

So a void is one transaction doing three things together or not at all, mirroring the shape of
`recordManualProduction` itself:

1. mark the entry voided (`voided_at`, `voided_by`, `void_reason`)
2. emit the `MANUAL_PRODUCTION_VOID` event, `balance_delta = −cartons`, and move both projections
3. withdraw the entry from the contractor ledger for that machine-day

Voids are **not** refused when the day's payment is already settled. If a contractor was paid
against cartons that are later voided, the ledger will then show them overpaid — which is the
correct statement of fact, and the balance carries forward as any other overpayment does. The
void's `void_reason` is what explains it to whoever reads the ledger later, so make the reason
required, not optional.

### This replaces the hand-clearing in §4

Once this exists, PC2's leftover test cartons are cleared from the UI — void the test entries, the
stock goes to zero, and there is a record of why. No improvised SQL on the live machine. §4's
"not zero" branch should only be used for carton stock that has no manual production entry behind
it (test QR cartons from Store Move In), which is a separate decision because carton identities
replicate.

## 6. Who may write cartons — role and lease

**Owner decision (2026-11-03): the role decides who adds Manual Production.** Cloud accounts
already delivers that: an admin assigns the Manual Production screen to a person, and they have it
on whichever PC they sign in to.

Role and lease answer different questions and both are needed:

| | Question | Mechanism |
|---|---|---|
| **Role** | *who* is allowed to enter production | cloud accounts (`docs/41`) |
| **Lease** | whether *two computers at once* may | `domain_leases`, `docs/37 §W` |

### Cartons get their own lease domain, and it follows the user

Not the raw material store domain — the person doing store in/out is not necessarily the person
entering production. Consistent with the owner's rule of 2026-10-23: **write-ownership follows the
user, not the PC**, so the holder can sit at any computer.

**The reason a lease is needed at all, which is not obvious:** `recordManualProduction` calls
`openMachineDayProgramInTransaction`, and **`machine_programs` and its seven child tables do not
replicate** (`docs/38 §1`, and the note in migration 097). Two people entering production for the
same machine on the same day from different PCs would each open a *local* day program. Neither PC
would hold the whole day, and the contractor ledger — which reads these entries against that
program — would be split across two machines with no way to total it.

Stock itself would survive this: carton events are append-only and sum correctly from anywhere.
It is the machine-day program and the contractor ledger that break. So the lease is protecting the
money, not the stock figure.

Classify it in `docs/37 §W` as a single-writer domain, and gate the write in the cloud RPC the way
raw material's is. When machine programs replicate, revisit whether cartons still need the lease —
and note that in §W so the constraint is not treated as permanent.

**One lease for all machines, deliberately.** Production is entered machine by machine — Machine 1
with its contractors, then Machine 2 — so the lease could in principle be per machine, letting two
people work on different machines at once. It is not, because one person enters production today
and a per-machine lease is a lot of moving parts for a bottleneck that does not exist. If a second
person ever needs to enter production for a different machine simultaneously, the granularity is
the thing to change, not the model.

## 7. Tests

- Contract tests mirroring `rawMaterialContracts.test.ts` and `stockEvents.test.ts`.
- Idempotence: the same event applied twice moves the figure once.
- The negative case: an arriving issue that would take a variant below zero parks, with its reason.
- A dangling `gatepass_id` applies cleanly and does not wait.
- End to end, the one that matters: Manual Production on PC A → sync → **PC B's carton figure
  rises**; gatepass on PC A → sync → **PC B's figure falls**; cancel → sync → it comes back.
- Cancel-twice restores once.
- Voiding a manual production entry lowers the figure on PC B after a sync, by exactly its cartons.
- Voiding is refused when a gatepass has already issued those cartons, and the refusal names the
  gatepass.
- Void-twice removes once and emits one event.
- A voided entry does not appear in the day's totals.
- A voided entry is gone from the contractor ledger for that machine-day, and the day's owed figure
  falls by exactly its share.
- A void with no reason is refused.

## 8. Order of work, and why nothing ships yet

1. **PC2's cutover** (`docs/36 §10`) — `scripts/clear-test-state.mjs` refuses any database not at
   schema **099**, so no release carrying a new local migration can go out before this.
2. **The cloud-accounts release** — local 100, cloud 020–025 (`docs/41 §12`). 025 is the
   `admin_save_role` fix and must not be skipped.
3. **This work**, branched off cloud-accounts: local **101**, cloud **026**. Number from the
   cloud-accounts branch, never from `main`, which still shows local 099 and cloud 019.

Build it on a branch now; ship it after step 2.

## 9. What this does not do

- Carton QR stays on hold. Nothing here turns it on, and §3.5 is written so that turning it on
  later cannot double-count.
- Gatepasses themselves still do not replicate. Only the stock movement travels. The boss sees
  an accurate figure; he does not see the gatepass document.
- Dispatch is still not tracked. Stock falls when the gatepass is made, which means cartons on the
  floor awaiting a truck are already out of the figure. That is the owner's decision, taken
  knowingly on 2026-11-03, and it should be revisited when a dispatch stage can actually be
  recorded.

---

## 10. Reconciled with what is built (2026-11-03)

The supplied `777-carton-and-role-tests.patch` was not on this machine, so local migration 101 was
written from this document rather than taken from that patch's commit 1. If the patch turns up, compare
its 101 with the one on `feat/cloud-accounts` before using either. Every difference from §§3-6 below is a
schema or mechanism detail; none changes a business rule. The ones that need the owner are marked.

| Point | This document | As built | Why |
|---|---|---|---|
| Quantity column | `quantity`, cartons | **`quantity`**, always cartons, always positive | The name §3.1 gives; "cartons" is its unit, as `inventory_stock_events.quantity` is the material's. |
| Which projection row | "the WAREHOUSE row of `stock_projection_by_location`" | Events carry **`location_type`** (always `WAREHOUSE`) and **`location_id`** | That row is keyed by location. Without the id a receiver cannot move the same row the origin moved. Manual Production's id is the store it stocked (`stock_location_id`); a gatepass takes from the store rows holding the cartons, fullest first -- one row while there is one store. |
| Event types | three in §3.1, four after §5 | **Four everywhere**: `MANUAL_PRODUCE`, `GATEPASS_ISSUE`, `GATEPASS_CANCEL`, `MANUAL_PRODUCTION_VOID` -- local 101, cloud 026, `@erp/domain cartonStock.ts` | §5 adds the void to the check; one list now. |
| The sign | `balance_delta`, `abs = quantity` | `balance_delta` is **checked against the type** (issue and void negative, the rest positive), locally, in the cloud and by the reader | Stronger than `abs`; the one rule is `cartonStockDelta`. |
| `origin_device_id` | `NOT NULL` | **Null on a row made here**, stamped with the sender on a received one (local); `NOT NULL` in the cloud, set by the push from the proven device | The convention every numbered table follows (local migration 087: "NULL is mine"). |
| Outbox | -- | 101 also widens `sync_outbox`'s type check | Without it `enqueueSyncEvent` quietly refuses the row (it never throws) and nothing travels. Found by the two-PC test. |
| Once only | "cancelling twice must not restore twice", "a void happens once" | Application guards **and** unique keys: one void per entry, one cancel per issued line and store row, locally and in the cloud | The database is the floor. |
| Negative stock | park as `CARTON_STOCK_WOULD_GO_NEGATIVE:<variantId>` | As written | A taking-out movement updates the rows, never upserts: SQLite checks `quantity_on_hand >= 0` on the row an upsert would insert, before it finds the conflict. |
| §3.5 Reserved | Reserved is 0, one figure | A line **issued at creation** reserves nothing and is never offered to a Store Move Out scan. A gatepass made **before** this keeps reserving as it did, and its cancel puts nothing back (it took nothing). | One rule (`ISSUED_AT_CREATION_SQL`), so older live gatepasses are never promised twice. |
| §3.5 screens | collapse the two numbers in `gatepassStock.ts` and every screen | **Not done.** Reserved is 0 for every new gatepass, so the figures agree, but the screens still show three columns. | A display change across several screens; left for its own change. |
| §6 lease | carton domain for Manual Production | **`CARTON_STOCK` covers all four movements, gatepasses included** (OWNER TO CONFIRM) | The push is leased per event type, and one aggregate carries all four. If a gatepass were written under another lease, a void on one computer and a gatepass on another could take the same cartons, and every receiver would park forever below zero. Consequence: gatepasses and Manual Production are entered on the computer holding the carton lease. Phase 1 has one such computer (PC2). |
| §6 "follows the user" | -- | The existing grant and handover (011): granted to a computer, labelled with the person; moved when they move | Nothing moves a lease automatically on sign-in, for any domain. |
| Void permission | -- | Same as recording: Live Production (OWNER TO CONFIRM) | The screen that records is the screen that voids. A stricter permission is a one-line change. |
| Contractor ledger | "withdraw the entry" | The ledger, Reconciliation and the day's totals read live entries only (`LIVE_MANUAL_ENTRY_SQL`) | The ledger is computed, never stored, so excluding the entry is the withdrawal. It lives where machine programs are -- the lease holder -- and does not replicate. |

**Still required before shipping (§4, unchanged):** confirm on PC2 that carton stock is empty, or void the
test entries from the screen once this is installed. The cutover and the cloud-accounts release come first (§8).
