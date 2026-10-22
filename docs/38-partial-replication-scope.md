# 38 — Partial replication: raw material, stock, cartons and production

**Status: PLAN, NOTHING BUILT.** Written 2026-10-22. **Not final** — the owner's decision stands
only after the two-PC carton test passes.

The narrower of the two scopes in `docs/37`. Raw material, stock, carton identities and
production replicate between PCs. **Documents stay local to the PC that made them. Logins stay
local to each PC.**

Read `docs/37 §0` first: its two prerequisites apply to this scope too, and §4 below says exactly
how much of them this scope needs.

---

## 1. What replicates, and what does not

### Replicates

| Group | Tables | Rows | Conflict rule |
|---|---|---|---|
| **RM movements** | `inventory_stock_events` | 5,977 | none — append-only |
| **RM packet lifecycle** | `raw_material_qr_events` | 5,609 | none — append-only |
| **RM packet identity** | `raw_material_qrs`, `raw_material_qr_batches` | 4,659 / 1,048 | insert-only; **status derived locally** |
| **Production** | `production_events` | 819 | none — contract exists |
| **Carton identity** | `qr_master`, `qr_codes`, `qr_batches` | 477 / 783 / 103 | insert-only; **status derived locally** |
| **RM master data** | `inventory_items`, `inventory_item_values` | 940 / 2,707 | **LWW — the one risky item in this scope, see §3** |
| **RM taxonomy** | `inventory_categories`, `_category_fields`, `_field_options`, `inventory_units`, `_item_unit_steps`, `unit_ladder_presets(+steps)` | ~690 | LWW |
| **Product master** | `product_variants`, `article_sizes`, `article_series`, `main_groups`, `product_groups`, `product_sub_groups`, `product_types` | ~60 | LWW |
| **Parties** | `parties`, `party_groups` | 18 / 10 | LWW — **required**: a supplier is mandatory when moving RM in (migration 060) |
| **Movement sessions** | `raw_material_receiving_sessions`, `raw_material_issue_sessions`, `store_receiving_sessions`, `store_move_out_sessions` | 165 / 109 / 6 / 4 | insert-once, close-once — **first close wins** |
| **Identity** | `factories`, `workstations`, `operators` | 1 / 1 / 0 | insert-only; each PC's own row plus the others' |

**Why the sessions are in.** They are numbered documents, which argues for excluding them — but
the RM movement events are wrapped in them, and an event whose session is missing cannot be
displayed or reconciled. They are also *not* like a gatepass: created once, closed once, never
re-edited, and their numbers are already block-partitioned so two PCs cannot collide. All four
already carry a `device_id` column, which is why they cost nothing in §4.

**Why the status columns are derived, not shipped.** `raw_material_qrs` and `qr_codes` both carry
a mutable status. Shipping it as a value makes the last writer win and silently misstate what is
in the store. The rule already written in `packages/sync/src/contract.ts` — *"mutable state that
has to be derived from the events on each computer, never shipped as a value"* — applies to both.

### Does not replicate

| Group | Tables | Why |
|---|---|---|
| **Documents** | `gatepasses(+lines)`, `sale_vouchers(+line_items)`, `cash_vouchers(+lines)`, `purchase_vouchers(+line_items)`, `machine_programs` and its 7 child tables, `dispatch_sessions`, `sale_returns` | The hard conflict cases in `docs/37 §1a`. ~250 rows in total, and gatepass + bill hold **four between them**. |
| **Approvals** | `stock_correction_requests`, `removal_requests`, `party_claims`, `access_requests`, `permission_requests` | Need transitions-as-events (`docs/37 §1 D3`) |
| **Logins** | `app_users`, `user_role_assignments`, `user_additional_permissions`, `user_notifications` | **Owner decision — see §2** |
| **Per-PC state** | `app_settings`, `qr_sequences`, `raw_material_qr_sequences`, `sync_outbox`, `user_sessions`, `system_health_snapshots`, `backup_history`, `schema_migrations`, `devices`, `metrics_*` | `docs/37 §0.2` |
| **Derived** | `inventory_stock_balances`, `stock_projection_by_variant`, `stock_projection_by_location`, `report_daily_summary` | Recomputed from the events above |

---

## 2. Logins stay local — owner decision, 2026-10-22

`app_users`, `user_role_assignments`, `user_additional_permissions` and `user_notifications` are
**excluded from replication entirely**. Each PC keeps its own accounts.

The owner's reasoning, recorded because the trade is not obvious and someone will later propose
"just sync the users too":

> Password hashes on every machine plus LWW resurrecting revoked accounts isn't a trade I want.

Both halves of that are real:

- `app_users` holds `password_hash` and `password_salt`. Replicating puts every user's credential
  material on every PC — including a stolen one, whose local database is **not encrypted**
  (`docs/36 §4b`).
- Under last-write-wins, a revocation on PC 1 can be overwritten by an older edit from PC 2, and
  a disabled account comes back to life. Clock skew between two PCs is enough.

### What that costs, stated plainly

- **A person needs an account on each PC they use**, created by an administrator on that PC.
- **Changing a password changes it on one PC only.** There is no "change it everywhere".
- **Disabling someone must be done on every PC.** This is the sharp edge: an administrator who
  revokes an account on PC 1 and forgets PC 2 has revoked nothing in practice. It needs to be a
  written step in the offboarding routine, because no software here will remind them.
- Each PC's `app_users` still bootstraps independently (`bootstrapAdmin`), so a new PC starts with
  its own first administrator.

**What it does not cost:** operators are a separate table (`operators`), already replicate, and
are what production events name. So a scan recorded by one person on PC 2 still reads correctly
on PC 1 — the *operator* is shared even though the *login* is not.

---

## 3. What someone at PC 2 can and cannot do

This is the section to read before approving the scope.

### Can

| | |
|---|---|
| **Receive raw material** | Scan packets in, with supplier. Session numbered from PC 2's own block. |
| **Issue raw material** | Scan packets out to a machine. |
| **Print RM packet labels** | Own serial block — no collision with PC 1 (`docs/36`, serial blocks). |
| **Print carton labels** | Same. |
| **Scan production** | Live Production and Receive Production, including adopting an unregistered carton. |
| **Store move in / move out** | The generic scanner. See the caveat in the next table. |
| **See all RM stock** | Both PCs' movements, recomputed locally from the replicated events. |
| **See all carton stock and production history** | Both PCs'. |
| **Create and edit materials, categories, units, products, parties** | LWW; see the warning below. |
| **Work entirely offline** | Indefinitely. Everything above is a local write first. |

### Cannot

| | Why |
|---|---|
| **See PC 1's gatepasses, bills, cash or purchase vouchers, or machine programs** | Documents do not replicate. They are invisible, not merely read-only. |
| **Create a bill** | Bills come only from gatepasses (`docs/23`), and gatepasses are local. A PC with no gatepass has nothing to bill. |
| **Use the same login as on PC 1** | §2. |
| **Approve a stock correction raised on PC 1** | Approvals do not replicate. |

### Must not be shown — two figures that would be confidently wrong

These are not capability limits. They are **correctness limits**, and they need UI guards rather
than documentation. Both have the same shape: a replicated base with a local-only overlay
produces a number that looks authoritative and is false.

**1. Customer and supplier ledger balances.** Parties replicate; vouchers do not. A ledger
balance is computed from `sale_vouchers` + `cash_vouchers` + `purchase_vouchers` + `sale_returns`,
so PC 2 would compute a balance from *its own* voucher set — currently none — and display **zero
for a party that owes money.** Somebody reads that and extends credit.

> **Required: PC 2 must not display party ledgers or balances at all.** Hiding them is correct;
> labelling them "incomplete" is not enough, because a number on screen is a number somebody
> will act on.

**2. Gatepass Reflected / Reserved stock.** `Reflected = Current − Reserved`, and Reserved comes
from open gatepass lines. Cartons and stock replicate; gatepasses do not. So on PC 2 Reserved is
zero and **Reflected equals Current — PC 2 shows stock that PC 1 has already committed to a
gatepass**, and will happily let an operator move it out.

> **Required: PC 2 must not show Reflected stock, and its Store Move Out must not auto-reconcile
> against gatepass lines** (the FIFO path in `docs/37 §1a` item 1). Current stock is honest on
> PC 2; Reflected is not.

This is the strongest argument for keeping gatepasses on one PC *operationally* as well as
technically: **dispatch stays a single-PC activity under this scope.** PC 2 is a production and
raw-material machine. If that is not acceptable, the scope has to grow to include gatepasses, and
with them the two hardest problems in `docs/37 §1a`.

### One real conflict risk inside this scope

`inventory_items` (940) + `inventory_item_values` (2,707) are the largest mutable set here and an
EAV model. Under LWW, a value edited on PC 1 while the item is re-categorised on PC 2 can leave
values attached to fields the new category does not have.

I am **not** claiming this scope is conflict-free. It is conflict-*small*: one table pair, edited
rarely, with a visible and repairable failure. Mitigations: treat
`(item, category)` reassignment as its own transition rather than a field write, and refuse a
value whose field does not belong to the item's current category on apply.

---

## 4. Prerequisites — shared with either scope, and startable now

**Both `docs/37` and this document need these. They can begin before the scope decision.**

### 4.1 The numbering fix — smaller here, still required

`allocateNumberInRange` throws `OUT_OF_RANGE` once a numbered table holds another PC's numbers
(`docs/37 §0.1`). Under *this* scope only four numbered groups replicate, and the session tables
already carry `device_id`:

| Table | Origin column | Needed |
|---|---|---|
| `raw_material_receiving_sessions` | `device_id` ✅ | — |
| `raw_material_issue_sessions` | `device_id` ✅ | — |
| `store_receiving_sessions` | `device_id` ✅ | — |
| `store_move_out_sessions` | `device_id` ✅ | — |
| `inventory_items` | **none** | add |
| `parties` | **none** | add |
| `article_sizes` | **none** | add |

**Three new columns, not fourteen** — plus the `countOutsideRange` rewrite and its tests, which
are the same work either way. The full scope needs the other eleven later.

### 4.2 The three-table exclusion list

`app_settings`, `qr_sequences`, `raw_material_qr_sequences` must be excluded from replication and
scrubbed from any restored snapshot (`docs/37 §0.2`). Identical for both scopes. This scope adds
`app_users` and its three companions to that list permanently (§2).

### 4.3 Also shared

Opening `sync_outbox.aggregate_type` beyond its five values; a general applier in place of
`applyEnvelope`'s two-type refusal; the projection rebuild; generalising the cloud
`sync_event_log` beyond its two triggers.

---

## 5. Effort

| Part | Effort |
|---|---|
| Prerequisites (§4 — 3 origin columns, numbering rewrite + tests, exclusion list, general applier, projection rebuild, outbox types, cloud log) | **3–4 wk** |
| Append-only groups: RM movements, packet lifecycle, packet + carton identity, production | **2–2.5 wk** |
| Projection rebuild correctness and order-independence | **1 wk** |
| Master data LWW: RM taxonomy, product master, parties + overwrite audit + clock-skew tie-break | **1–1.5 wk** |
| `inventory_items` / `_values` with the category-transition guard (§3) | **1 wk** |
| Sessions: insert-once / close-once, first-close-wins | **0.5 wk** |
| **UI guards: suppress ledgers and Reflected stock on a PC without documents** (§3) | **0.5–1 wk** |
| Backfill: re-derive the 868, retire them, snapshot + scrub + cursor, idempotent up-push (`docs/37 §2`) | **2–3 wk** |
| | **≈ 11.5–14.5 wk** |

Revised upward from the 7–9 weeks estimated in `docs/37 §4`, for two reasons found while writing
this document: **raw material cannot replicate without its master data**, which drags
`inventory_items` / `inventory_item_values` and the parties table into scope; and the two UI
guards in §3 are not optional.

Still roughly **two-thirds of the full scope** (`docs/37`: 15–21 wk) and it covers ~90% of the
rows, including every domain the owner named as important.

---

## 6. What this scope deliberately leaves unsolved

So that nobody later mistakes it for finished:

- Gatepasses, bills and dispatch remain single-PC. **Dispatch is a one-machine activity.**
- The FIFO reservation double-consumption problem (`docs/37 §1a` item 1) is avoided, not solved —
  by keeping gatepasses on one PC rather than by fixing it.
- The gatepass ↔ bill lock is untouched for the same reason.
- Machine programs stay local, so the one-program-per-machine-per-day key is never contested.
- Approvals stay local.
- Logins stay local permanently, by decision (§2).

A later move to full replication does not throw this work away: the prerequisites, the
append-only contracts, the projection rebuild and the backfill are all reused. What it adds is
document versioning and the two invariants above.
