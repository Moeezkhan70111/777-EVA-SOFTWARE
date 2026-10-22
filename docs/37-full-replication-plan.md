# 37 — Full replication: every PC holds the whole database

**Status: PLAN, NOTHING BUILT.** Written 2026-10-22. Supersedes nothing; `docs/34` (carton pilot)
remains the current scope until the two-PC carton test passes.

**Goal, as stated by the owner:** every PC holds the complete database, all domains, kept in
agreement through the cloud. Both machines see the same data, and either one keeps working with
everything if the internet drops.

Grounded in a row-count inventory of the live database taken 2026-10-22: **103 tables, 73
non-empty, ~27,000 rows.**

---

## 0. Two things that block everything else

Neither is a domain contract. Both are prerequisites, and the first is a hard stop.

### 0.1 Document numbering breaks the moment a numbered table replicates

`allocateNumberInRange` (`packages/data/src/database/numberRange.ts`) does this before issuing a
number:

```
const stray = countOutsideRange(db, site, range);
if (stray.count > 0) throw new NumberRangeError("OUT_OF_RANGE", ...)
```

`countOutsideRange` counts **every row in the table** whose number falls outside this computer's
block. Today that is always zero, because a computer only holds its own documents. Under
replication it is never zero: PC 1 holds PC 2's gatepasses, whose numbers are block 2 by design.

**Result: every numbered document creation fails on every PC, immediately.** No gatepass, no
bill, no party, no product.

The fix is to narrow the check from "any row outside my range" to "any row **I created** outside
my range" — which needs an origin column on every numbered table. Measured 2026-10-22:

| Numbered table | Origin column | Rows |
|---|---|---|
| `raw_material_receiving_sessions` | `device_id` ✅ | 165 |
| `raw_material_issue_sessions` | `device_id` ✅ | 109 |
| `store_receiving_sessions` | `device_id` ✅ | 6 |
| `store_move_out_sessions` | `device_id` ✅ | 4 |
| `gatepasses`, `sale_vouchers`, `cash_vouchers`, `purchase_vouchers`, `machine_programs`, `manual_production_entries`, `parties`, `article_sizes`, `party_claims`, `removal_requests`, `stock_correction_requests`, `machines`, `inventory_items`, `work_sections` | **NONE** ❌ | 14 tables |

So: **14 new columns, a backfill stamping existing rows with `desktop-main`, and a change to the
one function that every numbered document in the ERP depends on.** That function is currently
covered by `numberRange.test.ts`; those tests encode the present behaviour and will need
rewriting alongside it.

### 0.2 Three things must be excluded from replication, not merely unhandled

If these replicate, the system breaks in ways that look like data corruption:

| Table | Rows | What happens if it replicates |
|---|---|---|
| `app_settings` | 13 | Holds `numbering.block`. Every PC would be handed the same block and allocate colliding document numbers — the exact failure the block scheme exists to prevent. |
| `qr_sequences` | 35 | Per-PC carton serial counters. Replicating them merges the counters and both PCs issue the same serials. |
| `raw_material_qr_sequences` | 743 | Same, for packet labels. |

`sync_outbox`, `user_sessions`, `schema_migrations`, `system_health_snapshots`,
`backup_history`, `devices` and the PC's own `workstations` row join them: all are statements
about one machine, not shared facts.

**This exclusion list does double duty** — it is also the scrub list for the snapshot backfill in
§2.2. A restored snapshot that keeps `app_settings` hands the new PC block 1.

---

## 1. Part one — contracts, by replication class

Four classes. The class decides the conflict rule; the domain does not.

### Class A — Append-only events: conflict-free by construction

Insert-only, immutable, deduplicated by id. Two PCs cannot conflict because neither ever
modifies a row. **This is where ~80% of the data lives, and it is the easy 80%.**

| Table | Rows | Notes |
|---|---|---|
| `inventory_stock_events` | 5,977 | RM stock movements. The authority for RM stock. |
| `raw_material_qr_events` | 5,609 | Packet lifecycle (move in / move out / return). |
| `production_events` | 819 | **Contract already exists** (`PRODUCTION_PRODUCED`). |
| `inventory_item_audit` | 1,119 | |
| `audit_log` | 148 | |
| `raw_material_qr_batches` | 1,048 | Label run records. |
| `qr_codes` / `qr_batches` | 783 / 103 | Carton registry. Insert-only; `qr_codes.status` is the exception — see below. |
| `machine_program_*_carton_labels` | 87 | Label records. |

**Conflict rule: none needed.** Dedupe on primary key, `on conflict do nothing`.

**The one trap in this class:** `raw_material_qrs` (4,659 rows) *looks* like registry but carries
`updated_at` and a mutable status. It must be split exactly as `qr_master` already is — the
**identity** replicates insert-only, and the **status is derived locally** from
`raw_material_qr_events`. Shipping a packet's status as a value would make the last writer win
and silently misstate what is in the store. The same applies to `qr_codes.status`.

That rule is already written down in `packages/sync/src/contract.ts` for dispatch and returns:
*"mutable state that has to be derived from the events on each computer, never shipped as a
value."* It generalises to every domain here.

### Class B — Derived projections: never replicated, always recomputed

| Table | Rows | Recomputed from |
|---|---|---|
| `inventory_stock_balances` | 903 | `inventory_stock_events` |
| `stock_projection_by_variant` | 30 | `production_events` + store/dispatch events |
| `stock_projection_by_location` | 58 | same |
| `report_daily_summary` | 0 | events |
| Party ledger balances | *not stored* | `sale_vouchers` + `cash_vouchers` + `purchase_vouchers` + `sale_returns` |
| Gatepass "Reflected" stock | *not stored* | Current − Reserved |

**Conflict rule: not applicable — these are never sent.** This is the single biggest reason the
project is tractable: **no balance and no stock figure is stored as a shippable value anywhere.**
Ledgers are computed, stock is a counter over events. Nothing here needs delta merging.

**Work required:** a projection rebuild that runs after a pull applies events, and is correct
regardless of the order events arrive in. `applyEnvelope` deliberately does not touch stock today
("Counting arrivals while dispatch, returns and store movements stay local would make the
receiving computer's stock confidently wrong") — under full replication that restriction lifts,
and the rebuild becomes mandatory rather than forbidden.

### Class C — Per-PC local state: never replicated

See §0.2. `sync_outbox` (868), `app_settings` (13), `qr_sequences` (35),
`raw_material_qr_sequences` (743), `user_sessions` (3), `system_health_snapshots` (372),
`backup_history` (16), `schema_migrations` (84), `devices` (1), own `workstations` row,
`metrics_counters`, `metrics_timeseries`.

### Class D — Mutable shared records: the actual work

#### D1 — Master data: last-write-wins on `updated_at` is proportionate

| Tables | Rows |
|---|---|
| `parties`, `party_groups` | 18, 10 |
| `article_sizes`, `product_variants`, `article_series`, `main_groups`, `product_groups`, `product_sub_groups`, `product_types`, `sole_types` | 35 + 15 + small |
| `inventory_categories`, `inventory_category_fields`, `inventory_category_field_options`, `inventory_units`, `unit_ladder_presets(+steps)` | 52, 75, 403, 13, 15 |
| `machines`, `work_sections` | 3, 1 |
| `roles`, `role_permissions`, `job_role_options` | 8, 31, 2 |

**Conflict rule: LWW on `updated_at`, with soft delete and an audit row recording the overwrite.**

Defensible because these are edited rarely, by one person at a time, and a lost edit is *visible
and retypeable* — a party's phone number reverting is noticed and fixed in seconds. That is not
true of a document.

**Caveat:** `updated_at` is a wall-clock from the writing PC. Two PCs with skewed clocks resolve
LWW wrongly. Mitigation: compare `(updated_at, origin_device_id)` so ties and near-ties are at
least deterministic, and keep an overwrite audit so a surprising revert is explicable.

#### D2 — Documents: LWW loses data, and must not be used

| Document | Header rows | Child rows |
|---|---|---|
| Gatepass | `gatepasses` 2 | `gatepass_lines` 2 |
| Sale voucher (bill) | `sale_vouchers` 2 | `sale_voucher_line_items` 2 |
| Cash voucher | 0 | `cash_voucher_lines` 0 |
| Purchase voucher | 0 | `purchase_voucher_line_items` 0 |
| Machine program | `machine_programs` 5 | `runs` 14, `upper_lines` 27, `article_rates` 8, `closures` 2, `issue_batches` 84 |
| RM item | `inventory_items` 940 | `inventory_item_values` 2,707 |
| Sessions | `raw_material_receiving_sessions` 165, `raw_material_issue_sessions` 109, `store_*_sessions` 10, `dispatch_sessions` 2 | — |

**Conflict rule: document-level versioning, whole-document replace, and a refusal on divergence.**

Not row LWW. A gatepass is a header plus N lines; row-level LWW can let PC A's header win while
PC B's lines win, producing a document that neither operator wrote and that may violate its own
totals. The unit of conflict must be **the document**, with a monotonic revision per document and
a rule that a concurrent edit is **refused and surfaced**, not merged.

**Note the volumes.** Every document type except RM items has fewer than 200 rows, and the two
hardest (gatepass, bill) have **two rows each**. The hard conflict work protects almost no data
today — which is an argument about sequencing, not about skipping it.

#### D3 — Approval workflows: the transition must become an event

`stock_correction_requests` (40), `removal_requests` (12), `access_requests` (2),
`party_claims` (0), `permission_requests` (0).

**Conflict rule: model the approval as an append-only transition, not a status field.** A status
column under LWW lets "approved on PC 1" and "rejected on PC 2" resolve by timestamp — a business
decision settled by a clock. As events, both transitions are recorded and the first one wins
deterministically, with the second visible as a refused duplicate.

#### D4 — Users and permissions: a security decision, not just a conflict rule

`app_users` (3, holds password hashes and salts), `user_role_assignments` (2),
`user_additional_permissions` (4), `user_notifications` (89).

**Conflict rule: LWW is not acceptable here.** Two specific problems:

- **Replicating password hashes** puts every user's credential material on every PC, including a
  stolen one. The local DB is not encrypted (see `docs/36 §4b`).
- **A user disabled on PC 1 must be disabled everywhere, immediately.** Under LWW with a clock
  skew, a revocation can be overwritten by a stale edit from another PC — a revoked account
  coming back to life.

Recommend: replicate *identity and role assignment*, keep credential material local, and model
enable/disable as a transition (D3) so a revocation can never be overwritten by an older edit.
This needs an explicit owner decision before it is built.

---

## 1a. Where two PCs editing offline genuinely lose data

Seven, in descending order of how badly they fail.

1. **Gatepass reservations and FIFO store move-out — the hardest problem here.**
   `Reflected = Current − Reserved`, and a plain Store Move Out scan is auto-reconciled to the
   **oldest open gatepass line** (FIFO, stamped on `production_events.gatepass_id`). Two PCs
   scanning offline each pick the same oldest open line, and **one reservation is consumed
   twice**. This is not a lost edit — it is a wrong stock figure that reconciles against nothing,
   and no row-level conflict rule detects it. Needs either a reservation claim in the cloud (which
   breaks offline operation) or a reconciliation pass that detects and repairs double-consumption
   after the fact. **Needs a business decision: which PC's scan wins, and what the operator is
   told.**

2. **Gatepass ↔ bill lock.** `docs/23`: bills come only from gatepasses, and **bill quantities are
   LOCKED to the gatepass**. Edit the gatepass on PC 1 and the bill on PC 2 and the invariant
   breaks with no row-level conflict anywhere — each document is individually consistent and
   jointly wrong. Needs the gatepass and its bill to be one conflict unit.

3. **Multi-row documents** (all of D2). Header and lines resolving independently produces
   documents nobody wrote. Mitigated by document-level versioning; listed separately because it
   applies to every document type at once.

4. **Child ordinals.** `machine_program_runs.run_no`, `machine_program_upper_lines.line_no` and
   `inventory_category_fields.sort_order` are all allocated `MAX(...)+1` **per parent**. Two PCs
   adding a run to the same program offline both allocate the same `run_no`. Needs either per-PC
   ordinal partitioning or an ordering key that is not a dense integer.

5. **Machine program identity.** One program per machine per day is the key. Two PCs opening a
   program for the same machine and date offline create two programs that must become one.
   Merging them means merging their runs and reservations.

6. **`inventory_items` + `inventory_item_values`** (940 + 2,707). An EAV model and the largest
   mutable set by far. A value edited on PC 1 while the item is re-categorised on PC 2 can leave
   values attached to fields the new category does not have.

7. **Users and permissions** (D4). A revocation overwritten by a stale edit.

---

## 2. Part two — the one-time backfill

### 2.1 The 868 legacy outbox rows

Measured: **867 `PRODUCTION_EVENT`** (the pre-082 catch-all type) and **1 `DISPATCH_EVENT`**,
created 2026-10-06 → 10-13. Migration 082, which introduced `PRODUCTION_PRODUCED`, was applied
2026-10-15. **No production has happened on this machine since.**

**They are a dead queue, not a source of truth.** The authoritative data is the 819
`production_events` and 477 `qr_master` rows they refer to. So:

- **Do not rewrite them in place.** The old type name and payload shape do not match the current
  contracts, and patching a queue row is guessing at what a scan meant.
- **Re-derive instead.** Walk `qr_master` and `production_events` and enqueue fresh `QR_MASTER`
  and `PRODUCTION_PRODUCED` rows. Idempotent: `dedupe_key` is `QR_MASTER:{qr_id}` and
  `PRODUCTION_PRODUCED:{event_id}`, so re-running is a no-op.
- **Then retire the 868** — mark them `SYNCED` with a note, or delete them, once the re-derived
  rows have been acknowledged. Deleting a queue row destroys no business data; the events remain
  in `production_events`.

### 2.2 Getting ~27,000 rows up, and down to a new PC

Two directions, and the second should **not** be done by replaying events.

**Up (host → cloud).** Walk the authoritative tables in dependency order — master data, then
registries, then events — pushing in idempotent batches. Volume is small; the work is the
ordering and the idempotency, not the throughput.

**Down (cloud → new PC): snapshot plus log tail, not a 27,000-event replay.**

Replaying every event through a per-row applier is slow, and every row is a chance for a refusal
that strands a new PC halfway. Instead:

1. Restore a **database snapshot** on the new PC — the application already has verified backup
   and restore (`createBackup` / `restoreBackup`, and `docs/36 §6`).
2. **Scrub the Class C tables** from the restored copy (§0.2). This is mandatory: a snapshot that
   keeps `app_settings` hands the new PC **block 1**, and one that keeps `qr_sequences` hands it
   another PC's serial counters.
3. **Re-mint the device identity.** A copied data folder copies `device-identity.json`, and both
   machines then claim the same workstation (`docs/35 §6`). `device-credential.bin` will not
   decrypt on the new machine — which is deliberate — so the new PC must re-enrol.
4. **Set the pull cursor** to the snapshot's high-water mark and let the normal pull carry the
   tail.

This reuses machinery that exists and is tested, and it turns a 27,000-row risk into a file copy
plus a short catch-up.

---

## 3. Rough effort

Dev-weeks, assuming the business decisions in §1a are already made. They are not yet.

| Part | Scope | Effort |
|---|---|---|
| **Prerequisites** | §0.1 origin columns (14 tables) + `countOutsideRange` rewrite + its tests; §0.2 exclusion list; general applier; projection rebuild; open `sync_outbox.aggregate_type`; generalise the cloud `sync_event_log` beyond its two triggers | **3–4 wk** |
| Class A | Append-only events and registries (~20k rows, 8 table groups) | **1.5–2 wk** |
| Class B | Projection rebuild correctness, order-independence | **1 wk** |
| Class D1 | Master data LWW + overwrite audit + clock-skew tie-break | **1–1.5 wk** |
| Class D2 | Document versioning, whole-document replace, divergence surfaced in the UI | **3–4 wk** |
| §1a items 1–2 | Gatepass reservations / FIFO double-consumption, and the gatepass↔bill lock | **2–3 wk**, *after* a business decision |
| Class D3 + D4 | Approval transitions; users and permissions | **1–2 wk** + a security decision |
| **Part 2** | Backfill: re-derive, retire the 868, snapshot + scrub + cursor, idempotent up-push | **2–3 wk** |
| | **Total** | **~15–21 wk** |

That is **four to five months of focused work**, and it is a different project from the carton
pilot rather than an extension of it. Stated plainly because the estimate is the most useful part
of this document.

---

## 4. Recommended sequencing

**The domains with the most data are the easiest, and the domains with the hardest conflicts have
almost no data.** Gatepasses and bills — the two hardest problems in §1a — have **two rows each**
today. Raw material, which the owner has said matters most, is **~22,000 rows of append-only
events** and needs no conflict rule at all.

So sequence by difficulty, not by volume:

1. **Finish the carton pilot.** Two PCs, one scan, verified in the cloud. Nothing below is worth
   starting until the basic path is proven once.
2. **Prerequisites (§0).** Unavoidable, and nothing else works without them. The numbering fix in
   particular is load-bearing for every later domain.
3. **Class A + B — raw material and stock.** ~22,000 rows, append-only, no conflict rule, and it
   is the domain the owner named as most important. This is where the replication actually starts
   earning its keep.
4. **Class D1 — master data.** Small, low risk, makes the other PCs usable.
5. **Backfill (Part 2).** Once A, B and D1 are contracted, a new PC can be stood up for real.
6. **Class D2 / D3 / D4 and §1a.** The documents. Last, because they hold the least data and need
   the most design — and because by then there will be real two-PC experience to design against.

A defensible stopping point exists after step 5: **raw material, stock, cartons and production
replicate; documents stay local per PC.** That is roughly 7–9 weeks rather than 20, covers ~90% of
the rows and the domain the owner cares most about, and leaves the hardest invariants for when
there is operational experience to design them against. It is not "full replication", and it
should not be described as such — but it may be the better project.
