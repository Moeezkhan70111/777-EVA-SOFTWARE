# 777 ERP — Project Handoff / Onboarding

**Read this file first.** It is the orientation document for anyone — developer or AI
assistant — starting work on this codebase with no prior context. It describes **what is
actually built today**, where it lives, and the rules that govern changes to it.

Last verified against the code: **2026-10-07** (build PASS, test baseline recorded in §13).

---

## 0. The three authority documents, and their priority

| File | What it is | Authority |
|---|---|---|
| **The code itself** | `packages/*`, `apps/desktop/*` | **What exists.** Always wins on "how does it work today". |
| **`CLAUDE.md`** | 25 engineering rules (R1–R25) | **How to write code here.** Must be followed. See §14 for how its generic-stack vocabulary maps onto this project. |
| **`PROJECT_CONTEXT.md`** | 1,626 lines of business/product intent | **What the business wants.** Describes intended behaviour, UI direction, business rules, open questions. |

Resolution order when they disagree: **the owner's latest explicit instruction > the code >
PROJECT_CONTEXT.md**. PROJECT_CONTEXT.md §59 says this itself: do not assume the document is
more authoritative than the code.

`docs/` holds 24 numbered design/decision documents. The high-numbered ones are the live
decisions; read §16 for the index and which ones still matter.

**There is no git repository.** `ls .git` → nothing. There is no commit history to read, no
blame, no branches. The documentation in `docs/` and the comments in the code are the only
record of *why* something is the way it is. The code is unusually heavily commented for this
reason — **read the file header comments before changing a file**; they usually state the
business rule the file enforces and what must not be broken.

---

## 1. What the business is

**777EVA / T&T Traders** — a footwear (slippers) manufacturing and distribution business in
Pakistan. This is their internal ERP. It is a real production business system, not a demo.

It runs on the factory floor and in the office, used by people with widely differing computer
literacy — including store and gate operators whose entire interaction is *scan a QR code and
read a big green or red answer*.

Currency is **PKR**. Business timezone is **Asia/Karachi**. The business day runs
**06:00 → 06:00**, not midnight to midnight (`packages/domain/src/units.ts`).

### The physical flow the software mirrors

```
raw material in (supplier)  →  store  →  machine program (plan)  →  production
                                                                        ↓
                                                              carton QR generated
                                                                        ↓
   production scan  →  store move in  →  GATEPASS (reserve)  →  bill  →  store move out
                                                                             ↓
                                                        gate  →  dispatch scan  →  customer
                                                                             ↓
                                                                   return scan (on gate)
                                                                             ↓
                                                          store move in (back into stock)
```

**Core principle:** everything that physically enters or leaves the company is traceable
through a scan. QR/scanning logic is core ERP functionality, not a UI feature.

---

## 2. The actual technology stack

This matters because `CLAUDE.md` is written in generic web-stack vocabulary that does **not**
describe this project. What is really here:

| Layer | Technology |
|---|---|
| Shell | **Electron 43** (main process, CommonJS) |
| UI | **React 19** + plain CSS (`styles/theme.css`), bundled by **esbuild** |
| Renderer↔main | **`contextBridge`** preload exposing `window.desktop.api` (255 IPC channels) |
| Local database | **SQLite via `node:sqlite`** (Node's built-in; no native addon), WAL mode |
| Language | **TypeScript 5.9, strict**, `any` banned |
| Tests | **`node --test`** for packages, **Vitest + jsdom + Testing Library** for the renderer |
| Cloud | **Supabase Postgres** — target only, **not connected** |

### What is deliberately NOT here

**No Redux, no RTK Query, no Zod, no React Hook Form, no Tailwind, no HTTP client, no
router library, no component library, no ORM.** Do not introduce any of them (CLAUDE.md R22).
The equivalents already in use are listed in §14.

`node:sqlite` was chosen over `better-sqlite3` to avoid native build friction on Windows
factory machines. Fonts are bundled (`@fontsource-variable/inter`), not fetched — the app must
work with no internet.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ RENDERER  apps/desktop/src/renderer   (React 19, sandboxed) │
│   pages/ · features/ · components/shared/ · config/copy.ts  │
│   calls window.desktop.api via useDesktopApi()              │
└──────────────────────────┬──────────────────────────────────┘
                           │ contextBridge  (the ONLY bridge)
                   apps/desktop/src/preload.cts
                           │ ipcRenderer.invoke(IPC.xxx)
                   apps/desktop/src/shared/ipcChannels.ts   ← channel registry
┌──────────────────────────┴──────────────────────────────────┐
│ MAIN  apps/desktop/src/main.ts + main/ipc/*.ts              │
│   18 handler modules · authorize.ts enforces permissions    │
│   composes use cases, owns the SQLite handle                │
└──────────────────────────┬──────────────────────────────────┘
                           │
      ┌────────────────────┴───────────────────┐
      │ @erp/application   port-based use cases │
      │ @erp/domain        pure business rules  │
      └────────────────────┬───────────────────┘
                           │ ports implemented by
      ┌────────────────────┴───────────────────┐
      │ @erp/data   SqliteDatabase              │
      │   local-schema.sql + migrations/sqlite  │
      └────────────────────┬───────────────────┘
                           │ sync_outbox rows queued
      ┌────────────────────┴───────────────────┐
      │ @erp/sync   OutboxSyncService  ← STUB   │
      └─────────────────────────────────────────┘
```

### The rules this architecture encodes

1. **Offline-first, and offline-complete.** Every read and every write goes to the local
   SQLite file. Nothing in the app requires the network. Cloud sync is a future *addition*,
   not a dependency — `sync_outbox` rows accumulate for it.
2. **The renderer has no database access, no Node, no filesystem.** `contextIsolation: true`,
   `nodeIntegration: false`. Everything crosses the preload bridge.
3. **Business logic lives in `@erp/domain` and `@erp/application`, never in a page.**
   A React page renders and collects input; it does not compute stock, totals or eligibility.
4. **One source of truth per calculation.** Stock figures, bill line maths, money arithmetic,
   unit conversions, QR validity, gatepass transitions each exist in exactly one file.
5. **Authorisation is enforced in the main process**, not by hiding buttons (§10).

### Ports and use cases

`@erp/application` defines interfaces (`ports.ts`) — `TransactionManager`,
`QrMasterRepository`, `StockProjectionRepository`, `OutboxRepository`, … — and use cases that
depend only on those interfaces. `SqliteDatabase` implements all of them, and `main.ts`
`composeUseCases()` wires `db` into every port. **This is the seam a real backend would
replace.** Use cases:

```
ProcessScanUseCase              production scan
DispatchScanUseCase             dispatch to a party (gatepass-locked mode)
ReturnScanUseCase               record a carton return (commercial only)
StoreEntryScanUseCase           store move in
StoreExitScanUseCase            store move out (+ FIFO gatepass reconciliation)
ReceiveRawMaterialScanUseCase   raw material input
IssueRawMaterialScanUseCase     raw material output
Create/CancelGatepassUseCase    the gatepass document
MachineProgram* (6 use cases)   machine shift planning
Create/Update/ListParty…        party master
```

---

## 4. Repository map

```
777-software/
├── CLAUDE.md                  ← the 25 engineering rules. Read in full before coding.
├── PROJECT_CONTEXT.md         ← 1,626 lines of business intent, UI direction, open questions
├── README.md                  ← this file
├── PENDING.txt                ← owner's raw scratch notes of unimplemented asks
│
├── packages/
│   ├── domain/        pure business rules, no I/O  (constants, qr, money, units,
│   │                  unitLadder, pricing, gatepassStock, machineProgram, party, validate)
│   ├── application/   port-based use cases + eventBus + errors + ports
│   ├── data/          SqliteDatabase (752 lines) + database/*.ts (23 modules, ~16k lines)
│   │                  local-schema.sql (1,004 lines, 60 tables)
│   ├── scanner/       ScannerFrameAssembler — NOT WIRED (see §15)
│   └── sync/          OutboxSyncService — STUB, returns {0,0} (see §15)
│
├── apps/desktop/
│   ├── src/main.ts                Electron entry: paths, services, window
│   ├── src/main/
│   │   ├── authorize.ts           backend permission enforcement
│   │   ├── runtimePaths.ts        the ONE place filesystem locations are decided
│   │   ├── sessionStore.ts        encrypted session persistence
│   │   └── ipc/*.ts               18 handler modules, one per feature
│   ├── src/preload.cts            the only renderer↔main bridge
│   ├── src/shared/ipcChannels.ts  255 channels — the "endpoints.ts" of this project
│   └── src/renderer/
│       ├── app/        App.tsx, routes.tsx, format.ts, visibleSections.ts
│       ├── pages/      45 page components
│       ├── features/   12 feature folders (auth, billing, gatepass, machineProgram,
│       │               munshi, parties, rawMaterial, reports, returns, scanStation,
│       │               store, users)
│       ├── components/shared/   Modal, ConfirmDialog, StateView, TabStrip,
│       │               SearchableCombobox, ExportModal, UrduInput, StepHeading, ColorSwatch
│       ├── config/     copy.ts (user-facing text), branding.ts
│       ├── utils/      dates, qr, exportFile, importFile, reportDocument, print helpers
│       ├── state/      NotificationsContext
│       ├── platform/   print.ts  (mobile-compat abstraction — do not call window.open)
│       └── styles/     theme.css (6,835 lines: tokens + every component style)
│
├── migrations/sqlite/     57 forward migrations (001 → 057), most with .down.sql
├── supabase/schema.sql    cloud target schema — partial, unused
└── docs/                  24 numbered design/decision docs + archive/
```

---

## 5. The database

### Two-part schema

- **`packages/data/src/local-schema.sql`** — the base schema, 60 tables, idempotent
  (`CREATE TABLE IF NOT EXISTS`). Applied on every startup.
- **`migrations/sqlite/NNN_name.up.sql`** — 57 forward migrations applied in order at startup
  before any service initialises. A `.down.sql` exists where rollback is safe.

Migrations are **append-only history**. Never edit a migration that has shipped; add a new one.

> ⚠️ **The migration runner splits `.sql` files naively on `;`.** Never put a semicolon
> inside a migration comment, or the statement will be cut in half. This has bitten this
> project before.

SQLite runs in **WAL mode**. **One process per database file** — `app.requestSingleInstanceLock()`
enforces it, because two processes on one WAL file is how local ERP data gets corrupted.

### The important table groups

| Group | Tables |
|---|---|
| **Identity / org** | `factories`, `workstations`, `devices`, `operators`, `machines`, `work_sections` |
| **Products** | `article_sizes` (owns price), `product_variants` (owns stock), `article_series`, `product_groups`, `main_groups` |
| **QR + events** | `qr_master` (live unit: status + location), `production_events` (**append-only ledger**), `barcodes`/`barcode_batches`/`barcode_sequences` (generation registry) |
| **Stock projections** | `stock_projection_by_variant`, `stock_projection_by_location` |
| **Gatepass** | `gatepasses`, `gatepass_lines`, `gatepass_delivery_proofs` |
| **Billing** | `sale_vouchers`, `sale_voucher_line_items`, `dispatch_sessions`, `sale_returns` |
| **Cash / purchases** | `cash_vouchers`, `cash_voucher_lines`, `purchase_vouchers`, `purchase_voucher_line_items` |
| **Parties / discounts** | `parties`, `party_groups`, and four `party_*_discounts` tables |
| **Raw material** | `inventory_items`, `inventory_categories` (2-level), `inventory_category_fields`, `inventory_item_values`, `inventory_stock_events`, `inventory_stock_balances`, `inventory_units`, `inventory_item_unit_steps`, `unit_ladder_presets`, `raw_material_qrs`/`_batches`/`_events`/`_sequences`, `raw_material_receiving_sessions`, `raw_material_issue_sessions` |
| **Machine program** | `machine_programs`, `machine_program_runs`, `machine_program_upper_lines`, `machine_program_lines` |
| **Approvals** | `stock_correction_requests`, `removal_requests`, `access_requests`, `permission_requests` |
| **Users** | `app_users`, `user_sessions`, `roles`, `role_permissions`, `user_role_assignments`, `user_additional_permissions`, `user_notifications`, `job_role_options` |
| **Workspace** | `workspace_conversations`, `_messages`, `_tasks`, `_requests`, `_activity` |
| **Ops** | `app_settings`, `audit_log`, `backup_history`, `system_health_snapshots`, `metrics_counters`, `metrics_timeseries`, `sync_outbox` |

### Immutability rules

- `production_events` is **append-only**. Never update or delete a row. A mistake is
  corrected by a **compensating event** (e.g. a bring-back Store Move In that carries the
  gatepass id of the Store Move Out it reverses), never by editing history.
- Business records are **soft-deleted** (`deleted_at`), not removed.
- Deleting master data (a category, a material) requires an **administrator's approval** via
  `removal_requests`. Same for stock corrections via `stock_correction_requests`.

---

## 6. Domain model — the rules you must not re-derive

Everything in this section lives in **`packages/domain/src/`**. If you need one of these
figures anywhere, import it. Do not recompute it.

### Units (`units.ts`)

```
1 dozen = 12 pairs = 2 cartons        1 carton = 6 pairs = 1 scanned QR
sale voucher line unit  DOZEN
scan unit               CARTON
stock unit              CARTON
```

Never write `* 12` or `/ 2` outside this file. Operational day boundary (06:00) is here too.

### Money (`money.ts`) — R15

**All arithmetic goes through integer paisa.** `toPaisa` shifts the decimal on the number's
*text* (`1.005e2`) rather than `* 100`, which would already have lost precision.

```ts
toPaisa / fromPaisa / roundMoney
addMoney / subtractMoney / multiplyMoney / divideMoney
calculateSaleLine(…)   ← THE formula for a bill line
saleLineTotal / discountPerPairFromTotal
cartonReturnCredit(…)  ← a returned carton = calculateSaleLine over half a dozen
```

A sale line is **entered in dozens, priced per pair, discounted per pair**:
`dozenRate = pairRate × 12`, `amount = dozens × dozenRate`, `total = amount − (dozens × pairDiscount × 12)`.

**Storage is mid-migration.** Migration 029 added a `*_paisa` INTEGER sibling to every money
column; both are dual-written, and the REAL rupee column is still authoritative for readers
not yet switched. Migration 030 exists to retire the REAL columns — **when to run it is an
open owner decision (§17)**. `docs/20-money-schema-audit.md` has the full column inventory.

Display formatting: `renderer/app/format.ts` → `money()`.

### Dates (`utils/dates.ts`) — R16

Stored and transported in UTC; displayed in Asia/Karachi. Use `formatDate`, `formatDateTime`,
`formatRelative`. **Never do timezone arithmetic in a component.**

### QR identity — finished goods (`qr.ts`)

```
V1 (the only format generated and accepted today)
  ARTICLE_COLOR_SIZE_SERIAL        e.g.  SK6_BLUE_7/10_001

V2 (parser written, NOT in the default registry)
  FACTORY_ARTICLE_COLOR_SIZE_BATCH_SERIAL
```

`createDefaultQrParserRegistry()` registers **V1 only**. Parsing is versioned behind
`QrParserRegistry` so a format can be added without touching callers.

**One scanned QR = one carton = one physical unit.** A QR must already exist in the registry
and be a live unit in `qr_master`; a scan never creates a product, variant or QR.

#### QR lifecycle (`QR_STATUS` in `constants.ts`)

```
GENERATED ──production scan──▶ PRODUCED ──store move in──▶ WAREHOUSE ("In Store")
                                                                │
                                              store move out ───┤
                                                                ▼
                                                             TO_GATE
                                                                │
                                              dispatch scan ────┤
                                                                ▼
                                                           DISPATCHED
                                                                │
                                              return scan ──────┤  (credits the party,
                                                                ▼   NO stock movement)
                                                             ON_GATE
                                                                │
                                              store move in ────┤  (stock +1)
                                                                ▼
                                                            WAREHOUSE
```

Other `QR_STATUS` values: `SOLD`, `DAMAGED`, `SCRAPPED`, and legacy `RETURNED` (written by the
old return flow that credited stock on the return scan — do not write it). `GENERATED` and
`VOID` are **`QR_REGISTRY_STATUS`**, a separate enum describing a generated code that is not
yet a produced unit — do not mix the two.

> **A carton return is TWO events.** `ReturnScanUseCase` records the commercial return only
> (a `sale_returns` row crediting the party at the rate that carton's own voucher line was
> billed at, status → `ON_GATE`). It deliberately has **no** `stockProjectionRepo`. The
> carton re-enters stock only when a plain Store Move In receives it. `ON_GATE` ≠ `AT_GATE`
> (§ gatepass) — two different things must not share one word.

The party credited is **read from the carton's own latest `DISPATCHED` event** →
`dispatch_session_id` → voucher → party. Never guessed. A carton dispatched without a
selected bill has no attribution and its return is **refused** rather than misattributed.

### QR identity — raw material (`rawMaterialQr.ts`)

A **completely separate identity, registry and scanner**. A packet and a carton never share
one.

```
v2 (generated today)   RM_PARTYTOKEN_ITEMTOKEN_SERIAL     e.g.  RM_6_42_6
v1 (still accepted)    RMQR_PARTYCODE_ITEMCODE_SERIAL     e.g.  RMQR_PTY000001_RM000042_000006
```

v2 shortened the identity because the long form hurt scan reliability at label print size.
Labels already printed under v1 must keep working, so both parse; only the generator moved.

The carton store screens **recognise a packet label and turn it away** with a pointer to the
Raw Material pages (`isValidRawMaterialQrId` is called in the store use cases).

Raw material QR is **generation-only** — there is no status/location lifecycle like
`qr_master`. Movement is recorded in `raw_material_qr_events` + `inventory_stock_events`.

### The Gatepass journey (`constants.ts`, `gatepassStock.ts`)

**The Gatepass is the master operational document.** The QR is a carton's identity; the
gatepass says how far the document those cartons travel on has got.

```
CREATED ──bill made──▶ BILLED ──last carton out of store──▶ AT_GATE
   │                      │                                    │
   │ cancel               │ bill deleted                       │ last carton dispatch-scanned
   ▼                      ▼                                    ▼
CANCELLED             CREATED                              DISPATCHED ──photo──▶ DELIVERED
```

`GATEPASS_TRANSITIONS` + `canTransitionGatepass()` are enforced by the data layer.
**There is no manual status control anywhere in the UI** — every move is the consequence of
one business operation, written in the same transaction as that operation. Nothing walks the
journey backwards past a physical move: once a carton has left the store the document cannot
be cancelled or reopened (a controlled reversal does not exist yet).

`CREATED` displays as **"Gatepass Issued"**; the stored value stays `CREATED` because every
existing row and query uses it.

`GATEPASS_STAGES` maps each status to a desk's queue (label + the permission of whoever works
it + whether it counts as pending). `GATEPASS_TRANSITION_NOTICE` sends exactly one
notification per transition, in the same transaction, so a notice can never exist for a change
that did not happen.

#### The three stock figures (`gatepassStock.ts`)

```
Current Stock    physical cartons in the store right now   (stock_projection_by_location @ WAREHOUSE)
Reserved         Σ over open gatepass lines of (requested − dispatched from store)
Reflected Stock  Current Stock − Reserved      ← what a NEW gatepass may draw on
```

Creating a gatepass **reserves; it never moves stock**. Both figures are re-read **inside the
write transaction**, never trusted from the screen, so two clerks cannot reserve the same last
carton. Cancelling releases only what was still outstanding.

#### FIFO reconciliation — a rule worth memorising

**The store scanner is generic and must stay generic.** The operator scans; the carton moves;
nothing about a gatepass is asked. Inside the same transaction, `StoreExitScanUseCase` finds
the **oldest open gatepass line still owing that exact variant** (article + colour + size) and
stamps that gatepass id on the `STORE_EXIT` event. That stamp is what turns "requested 2" into
"moved out 1, outstanding 1".

The reservation **never decides whether the carton may leave** — the physical movement is the
authority and the reservation follows it. Both in one transaction, so neither can happen alone.
**Never add a "which gatepass?" prompt to the store scanner** (owner's explicit rule).

### Bill ↔ Gatepass lock (`docs/23`)

| | Belongs to | Who may change it |
|---|---|---|
| Article, size, **quantity** | **the gatepass** | nobody, on the bill |
| Rate per pair, price type, "less" per pair | **the bill** | the billing desk |

`assertBillLineMatchesGatepass` runs before **every** line write on a gatepass-linked voucher
and refuses with `QUANTITY_DIFFERS`, `LINE_NOT_ON_GATEPASS`, `LINE_ALREADY_ON_BILL` or
`LINE_MAY_NOT_BE_REMOVED`. If a quantity is wrong, the **gatepass** was wrong — cancel it and
cut the right one.

**Every bill is made from a gatepass**: the desk opens a gatepass number, and the draft is
built by `voucherDraftFromGatepass`. One bill line per **article + size** — colours are folded
together, because colour is a store concern and never appears on a bill. (The data layer still
accepts a null `gatepass_id` for legacy rows; the UI does not offer it.)

Cancelling a gatepass that has a bill raises a **delete-the-bill alert** rather than silently
touching the bill.

### Pricing (`pricing.ts`)

`article_sizes.selling_price_paisa` is the authoritative NORMAL price. B-TYPE is **derived**:

```
normal ≤ 500        → normal − 150
501 ≤ normal ≤ 599  → normal − 170
normal ≥ 600        → normal − 200
```

Returns `{ ok: false }` for a missing/invalid NORMAL price — B-TYPE is never invented.

### Discount hierarchy

Resolution order, most specific first (`DISCOUNT_SOURCE`):

```
ARTICLE  >  ARTICLE_SERIES  >  PRICE_RANGE  >  PRODUCT_GROUP  >  NONE
```

Per party. `resolveProductDiscount` / `resolveProductDiscountWithPrice` are the only resolvers.
"Less" is auto-resolved on a rate change and on reopen, but **a figure the desk typed is kept**.

### Unit ladders (`unitLadder.ts`)

A raw material's own chain of unit facts — a roll of *this* nawaar is 975 metres, a roll of
*that* one is not:

```
1 ROLL = 975 METRE ;  1 METRE = 40 INCH      base unit = INCH (the bottom of the chain)
```

Stock is held in the **base** unit, so a ladder never reinterprets a recorded balance — it
lets the same number be read and typed in bigger words. Ladders are per-material, can be
copied across a material's colour siblings, and can be saved as presets.

### Machine Program (`machineProgram.ts`, `docs/24`)

One **machine** on one **date**. The machine has two **injectors**; each injector gets one or
more **sole runs** (sole colour + article + size); each run gets **upper lines** (a colour and
a quantity in DOZEN).

```
MACHINE 1 · 4 Oct 2026
  INJECTOR 1
    BLACK sole · SK6 7/10
      BLACK upper  30 DOZEN
      GREEN upper  10 DOZEN
```

The **upper lines are what the program reserves**, mirroring the gatepass exactly:

```
Physical   what the store holds of an upper (its balance, in its stock unit)
Reserved   Σ over live PROGRAMMED lines of (quantity − scanned out for that line)
Available  Physical − Reserved
```

A program reserves; it never moves stock. **Raw Material Output** is where the reservation is
consumed. `PARTIALLY_USED` is deliberately **not** a stored status — it is derived from the
event log so it can never disagree with what happened at the scanner.

Owner decisions as of 2026-10-07: **no sole type** (the `sole_types` master and its UI are
gone; `machine_program_runs.sole_type_id` is kept nullable and never written again), **no
supplier on a line**, the upper picker shows **every colour** of the upper (the sole's colour
never narrows it), the contractor is **permanent on the machine**, **Dana is shown but never
reserved**, and the article/size match is **exact**.

---

## 7. Feature-by-feature state

Everything below is **implemented and working** unless marked otherwise.

### Scanning stations

| Station | Route | Use case | What it does |
|---|---|---|---|
| Live Production | `live-production` | `ProcessScanUseCase` | QR → `PRODUCED`, stock +1 at FACTORY |
| Store Move In | `store-scanning` | `StoreEntryScanUseCase` | `PRODUCED`/`TO_GATE`/`ON_GATE` → `WAREHOUSE` |
| Store Move Out | `store-move-out` | `StoreExitScanUseCase` | `WAREHOUSE` → `TO_GATE` + FIFO gatepass stamp |
| Live Dispatch | `live-dispatch` | `DispatchScanUseCase` | → `DISPATCHED`, bill-matched or gatepass-locked |
| Return Scanning | `live-return` | `ReturnScanUseCase` | `DISPATCHED` → `ON_GATE` + party credit |
| Raw Material Input | `raw-material-input` | `ReceiveRawMaterialScanUseCase` | supplier session, packet in, printable receipt |
| Raw Material Output | `raw-material-output` | `IssueRawMaterialScanUseCase` | packet out to the section that consumes it |

Scanners are **keyboard-wedge** HID devices (Honeywell Xenon 1902 tested). Input is shaped by
`renderer/utils/qr.ts` (`sanitizeScanInput`, `isCompleteQr`) — **not** by `@erp/scanner`,
which is unwired (§15). Audio feedback: `assets/branding/correct.mp3` / `error.mp3` via
`utils/playScanSound.ts`.

Gatepass-locked dispatch exists because **a bill has no colour** (price lives on article +
size), so the ordinary allowance would call every colour "ALL COLORS". The gatepass knows the
colour, so it supplies the allow-list while attribution stays bill-keyed.

### Stations instead of a navbar

Two roles work from **tile-card stations**, not the navigation bar, because their users should
see three big buttons and nothing else:

- **Store Station** (`store-home`) — `features/store/`
- **Munshi Station** (`munshi-home`) — `features/munshi/`. Babar's station; the role holds
  `munshi` + `gatepass` + `stock`. Its cards open the ordinary Gatepass screens, and the
  Gatepass list opens on **All**. The `munshi` permission grants **no business operation of
  its own** — each card is still gated by the permission that action always needed.

### Gatepass

Create (`gatepass`), list with per-stage counts (`gatepass-list`), store scan and dispatch
scan views, journey timeline, delivery/builty proof photo, cancel (own permission:
`gatepass-cancel`). Printing: `utils/gatepassPrint.ts`, `gatepassGrid.ts`, `gatepassSlip.ts` —
the printout **mirrors the physical book's grid** (owner requirement; see §11).

### Billing & accounts

- **Sale vouchers** — from a gatepass, quantity-locked, rate/discount editable,
  `VoucherNavigator` for sequential entry, printing in `utils/saleVoucherPrint.ts`.
  Bill print layout still **awaits the owner's paper bill** as the reference.
- **Cash vouchers** — multi-line, receipt/payment, mode of transfer + transfer details.
- **Purchase vouchers** — supplier bills; **do not touch stock** (commercial record only;
  the raw material scans are the physical record).
- **Ledgers** — customer and supplier, with opening balances. **Three sources feed a customer
  ledger: sale vouchers, cash vouchers and `sale_returns`.** A return dated before the ledger
  window lands in the opening balance.
- **Customer / supplier balance** lists, party credit limit checked on voucher creation.
- **Discount Policy** screen for the four discount levels.

### Products & QR

Product master (`article_sizes` owns price, `product_variants` own stock per colour), product
images, rate list with a previous-rate "difference" view, field/list management, QR Generator
(batches + sequences), QR Management (search, void, restore, mark damaged), QR Journey (one
screen covering **both** finished-goods and raw-material codes through one journey API).

### Raw Material

**Eight pages were consolidated into one tabbed workspace** (`raw-material`, 2026-09-28) —
`features/rawMaterial/RawMaterialWorkspace.tsx` with Stock / Setup / Labels / Receipts tabs.
Scan stations stayed separate. Packing moved into the material drawer.

Two-level categories, per-category attribute definitions with option lists, per-material pack
name and unit ladder with a unit-reachability check, CSV import of masters, export,
stock corrections **requiring admin approval**, category/material removal **requiring admin
approval**, re-filing (move a category under another parent, move a material to another
category) with a preview.

### Users, roles, permissions, workspace

Local auth (`app_users`, hashed), `BootstrapAdminScreen` for the very first admin,
sign-up → `access_requests` → admin approval, roles with permission sets, per-user additional
permissions, authority level, job roles, permission requests, in-app notification centre, and
a small internal **Workspace** (messages, tasks, requests, activity feed).

### Ops

Settings (`app_settings`), manual + daily-checked **Backup** with restore and verification,
**Health** monitor from local metrics, structured **Log** viewer with filter and export,
**Reset Database** (writes `data-migration.json` so a relaunch never re-inherits the legacy DB).

### Reporting / export

- "Excel" = **UTF-8 CSV** via `utils/exportFile.ts`
- "PDF" = **a print window** via `utils/reportDocument.ts` and `platform/print.ts`
- One import path only: raw material master, per-category template
- **No `xlsx` library, no PDF generation library, no PDF import.** Do not add one.

Daily production / daily dispatch reports group by the **06:00 operational day**.

---

## 8. Navigation

Routes are a string union in `renderer/app/routes.tsx` (≈70 routes). The navbar structure
lives in `components/layout/Navbar.tsx`:

```
Dashboard · Scanning · Store · Munshi · Gatepass · Inventory · Setup · Billing
          · Settings · Health · Logs · Workspace
```

Each navbar entry id **is** a permission code. `features/users/permissions.ts` derives the
human label for a permission from this same catalogue, so the admin screen and the navbar can
never drift apart.

`visibleSections.ts` is a switchboard kept (now returning `true` for everything) so a section
can be pulled back out of the app later without touching every call site.

Keyboard shortcuts (`shortcutRouteMap`): `F1` dashboard, `F2` live production, `F3` stock,
`F4` production history, `F5` daily production, `F6` live dispatch, `F7` live return,
`F8` settings, `F9` store scanning.

---

## 9. Where data lives on disk

All paths are decided in **one place**: `apps/desktop/src/main/runtimePaths.ts`.

```
%LOCALAPPDATA%\777-erp\            ← persistent (the live data root)
    erp.local.sqlite               the database
    session.bin                    encrypted sign-in state
    product-images/  delivery-proofs/  logs/  backups/  session/

%TEMP%\777-erp-cache\              ← disposable
    chromium-cache/  scratch/      (print-to-PDF scratch files)
```

Override with `ERP_DATA_DIR=<folder>` (used by operators and tests).

**Legacy roots** (`%TEMP%\erp-desktop-runtime`, `apps/desktop/.runtime`) are *read once* by a
fresh install, copied, verified, and **never deleted**. The migration result is logged and
recorded in `data-migration.json`.

---

## 10. Security (R9 / R25)

- **Backend authorisation, always.** `main/authorize.ts` exposes `requireUser`,
  `requirePermission`, `requireAnyPermission`, `requireAdmin`. **Every write handler calls
  one of them.** Hiding a button is not authorisation. `ADMIN` bypasses permission codes.
- The session is resolved from an explicit token when given, otherwise from the session that
  window last proved (bound on sign-in/`get-session`, released on logout).
- **No token in `localStorage`.** The renderer holds the token in memory only; persistence is
  encrypted in the main process (`sessionStore.ts`, `session.bin`).
- `contextIsolation: true`, `nodeIntegration: false`, sandboxed preload. The preload is
  **bundled** by esbuild because a sandboxed preload cannot `require` project files.
- **Never render unsafe HTML.** `utils/html.ts` is the escaping helper used by every
  print/report document builder.
- Validate at the boundary. The only external boundary today is renderer→main IPC input, and
  handlers narrow it manually (there is no Zod here).
- No secrets in the client, no logging of passwords/tokens/financial secrets.

---

## 11. UI conventions

### Design tokens (R3)

**`renderer/styles/theme.css`** is the one source of truth — 6,835 lines holding both the
tokens and every component style. Tokens are CSS custom properties:

```css
--primary-blue --text --text-2 --text-3 --bg --surface-1..3 --border
--ok --warn --err --info (+ matching --*-bg)
--radius-sm..2xl  --shadow-sm/md  --ease-spring --ease-out-expo
```

A shadcn preset (`b1sACBL16`) supplies the raw values under an **`--sc-` prefix**; the
semantic layer above maps them to the app's own names. Swapping presets means pasting new
`--sc-*` values — nothing below changes. **Never hardcode a colour or a hex value in a
component.**

### Visual direction (PROJECT_CONTEXT §5)

Apple-inspired, professional, clean, minimal, desktop-first, information-dense, restrained
colour. White / light grey / deep navy / restrained green and red.

**Explicitly forbidden:** neumorphism, claymorphism, glassmorphism, excessive gradients, 3D
cards, heavy shadows, floating blobs, futuristic graphics, overly colourful dashboards. *"The
application should NOT look like an AI-generated SaaS template."*

> ⚠️ **GPU first-draw jank.** On this hardware, gradients, `drop-shadow`, inset/odd
> `box-shadow`, one-sided borders and **any `backdrop-filter`** stall the GPU 50–100 ms on
> first draw. Stay inside the safe set already used in `theme.css`.

> ⚠️ **Modal layering.** An in-page modal paints *under* the navbar, because `.page-content`
> creates a stacking context. Portal to `body` (as `ProductDetailModal` does).

**Paper-first printouts.** Printouts and document views mirror the physical books the office
already uses (the gatepass grid is the reference). Create/entry screens may use compact cards
with a sticky summary panel.

### Reusable components (R1)

Before writing UI, check `components/shared/`: `Modal`, `ConfirmDialog`, `StateView`,
`TabStrip`, `SearchableCombobox`, `ExportModal`, `UrduInput`, `StepHeading`, `ColorSwatch`.
Feature-local shared pieces live in each `features/*` folder. **One source of truth per
repeated pattern** — if a pattern appears twice, extract it.

### The four states (R12)

Every async screen must handle **Loading / Empty / Error / Success** explicitly. `StateView`
exists for this. An error state needs a **Retry** where retrying makes sense.

### Copy and i18n (R21)

User-facing text goes in **`renderer/config/copy.ts`** (796 lines), the seam for future
**Urdu**. Migration is incremental: shared components and auth use it; other pages move their
text there as they are touched. Developer-facing strings (log messages, error codes) do not
belong there.

Urdu is already partly live: `UrduInput`, `utils/urdu.ts`, and Urdu name columns on parties,
raw material colours and sale voucher sub-parties.

### Accessibility (R18)

Every interactive element needs an accessible name. **Never communicate with colour alone** —
the `.sr-only` class in `theme.css` exists to pair a colour cue with announced text
(`✓ Production Successful`, not just green).

### Mobile compatibility (R7 / R19)

The app will run inside an Android/iOS wrapper later. **Do not call `window.open()` or use
`target="_blank"`** — go through `renderer/platform/print.ts`. Mobile UI need not be built
now; the architecture must not block it.

---

## 12. Build, run, test

```bash
npm install                 # workspaces: apps/* and packages/*

npm run build               # tsc across all 6 packages + esbuild the renderer
npm test                    # every package's suite
npm start                   # build, then launch Electron
npm run --workspace @erp/desktop dev    # esbuild watch + Electron
```

Per package: `npm run --workspace @erp/<name> test`
(`domain`, `application`, `scanner`, `data`, `sync`, `desktop`).

`lint` is a no-op everywhere — there is no ESLint configured. **TypeScript strict mode is the
only static gate**, so `npm run build` must stay clean.

### Launching the app to see a change

Hardware acceleration is **disabled** in `main.ts`. For scripted screenshots of a renderer
screen there is a working recipe: a fake-API preload + a command-file loop, with
`ELECTRON_RUN_AS_NODE` unset; **shoot twice** (the first frame is stale) and **never reload**.
Write helper scripts with the Write tool, not a Bash heredoc (§15).

---

## 13. Current test baseline (verified 2026-10-07)

`npm run build` — **PASS**, no TypeScript errors.

| Suite | Result |
|---|---|
| `@erp/domain` | **46 / 46 pass** |
| `@erp/scanner` | **3 / 3 pass** |
| `@erp/application` | **66 / 67 pass** — 1 fail: *"cancel: releases only what was still outstanding…"* |
| `@erp/data` | **386 / 393 pass** — 7 fails (listed below) |
| `@erp/desktop` (renderer) | **354 / 381 pass** — 27 fails across 5 files |
| `@erp/sync` | no tests |

**These failures are a known pre-existing baseline, not regressions from recent work.** Do
not "fix" them as a side quest, and do not let them mask a *new* failure: record the counts
above, run the suite before and after your change, and only the delta is yours.

`@erp/data` failures:
```
a return dated before the ledger window lands in the opening balance, not the entries
role assignment resolves effective permissions and additional overrides
saleable variant read returns exact variant metadata and projected stock
ArticleSize owns shared price while color variants own independent stock
discount resolver uses ArticleSize-owned relationship metadata for every color
saved vouchers create a pending dispatch session and allow only bill-matching variants
product CRUD and inventory valuation work offline
```

Renderer failures: `PartyListPage.test.tsx` (15), `App.test.tsx` (9),
`GatepassPage.test.tsx` (1), `ProductListPage.test.tsx` (1), `ProductFormPage.test.tsx` (1).

---

## 14. CLAUDE.md ↔ this codebase

`CLAUDE.md` is binding, but it is phrased for a generic React/Redux web app. These are the
agreed equivalents (settled 2026-09-18; the full audit is `docs/19-claude-md-compliance-audit.md`).
**Honour the rule's intent through the mapped mechanism — do not install the named library.**

| CLAUDE.md says | 777 ERP equivalent |
|---|---|
| RTK Query / API layer | `useDesktopApi()` → preload → IPC channel → main handler → `SqliteDatabase` |
| `src/services/api/endpoints.ts` (R4) | **`apps/desktop/src/shared/ipcChannels.ts`** — add a channel there first; nothing else may spell an `"erp:…"` string |
| `USE_MOCKS` seam (R5) | `@erp/application` ports. `SqliteDatabase` is the local implementation; `@erp/sync` is the cloud seam |
| Redux slice for shared state (R6) | React context — `SessionContext`, `NotificationsContext` |
| Zod at boundaries (R25) | manual narrowing in IPC handlers (the only external boundary today) |
| React Hook Form + Zod (R17) | plain controlled React state + explicit validation in the data layer |
| Tailwind tokens `bg-primary` (R3) | CSS custom properties in `styles/theme.css` |
| `formatMoney()` (R15) | `renderer/app/format.ts` → `money()`, over `@erp/domain/money.ts` |
| Feature folders (R11) | `renderer/features/*` (12 of them) + `packages/*` by layer |
| Centralised copy (R21) | `renderer/config/copy.ts` |

Rules that apply **verbatim, with no translation**: R2 (simple code — functions ≲40 lines,
components ≲200, ≤3 nesting levels), R8 (business logic over UI convenience), R9 (security),
R10 (strict TS, no `any`), R12 (four async states), R13 (no business logic in JSX), R14 (no
magic strings — use `packages/domain/src/constants.ts`), R15, R16, R18, R19, R20, R22 (do not
install packages), R23 (rule priority), R24 (AI-readiness: clean service boundaries, no AI
dependencies added speculatively).

**Rule priority when they conflict** (CLAUDE.md §23):

```
1. Data integrity  2. Existing business rules  3. Security  4. Correct architecture
5. Maintainability  6. Performance  7. UI/UX  8. Convenience
```

---

## 15. Known gaps — what is NOT built

| Gap | Detail |
|---|---|
| **Cloud sync** | `@erp/sync`'s `OutboxSyncService.runOnce()` is a stub returning `{0, 0}` and is **not wired into the app**. `sync_outbox` rows accumulate and are never uploaded. `supabase/schema.sql` is partial and unused — it does not define the sales/cash/discount tables at all. |
| **`@erp/scanner`** | `ScannerFrameAssembler` is tested but **not imported anywhere**. The renderer does its own keyboard-wedge handling in `utils/qr.ts`. Either wire it or retire it; do not duplicate it. |
| **Live Dispatch from WAREHOUSE** | A known gap in the gatepass reservation flow. |
| **Money storage migration** | Migration 030 (retire the REAL rupee columns) exists but **has not been run** — pending an owner decision. Readers are mid-switch to `*_paisa`. |
| **`inventory_stock_events`** | The complete movement ledger for a raw material. Historically **no read API at all**; check before assuming a screen can show it. |
| **Controlled reversal** | Once a carton has left the store, a gatepass cannot be cancelled or reopened. The compensating reversal does not exist. |
| **Bill print layout** | Awaits the owner's physical paper bill as the reference. |
| **Raw material issue destinations** | The data layer and destination model support more than the current screen exposes (`docs/21` §4). |
| **ESLint** | Not configured; `lint` is an echo in every package. |
| **`PENDING.txt`** | The owner's raw notes of asks not yet built — raw material store scanning sessions, pending-scan-without-rate, and the **upper packing system** (e.g. `10/12, 7/10 → 2`; `1/6, 11/13, 8/10, 24/29 → 3`; `SK44 11/13 → 2`). |

---

## 16. Open business decisions

Ask the owner; do not decide these in code.

1. **Discount authority** — who may override a resolved discount (Phase 2, pending).
2. **When to retire the REAL money columns** (migration 030).
3. **Who may edit raw material packing.**
4. From PROJECT_CONTEXT §71, treat as not final: the QR payload beyond the identity string,
   the cloud architecture, the sync implementation, the auth model, the exact
   role/permission matrix, the final schema, the accounting debit/credit conventions, and the
   deployment architecture.

Already resolved (do not reopen): bootstrap admin, `deleteSaleVoucher`, the gatepass rename,
the gatepass hierarchy (Article > Series > Price Range > Group), bill quantities locked to the
gatepass, store scanner stays generic.

---

## 17. Environment quirks that will cost you time

The dev machine is **Windows 11 + PowerShell 5.1**, with a Bash (Git Bash) tool also available.

| Quirk | Do this instead |
|---|---|
| `Get-Content`/`Set-Content` mangle `—` (em dash) in this repo | use .NET UTF-8 APIs, or the Write tool, for scripted rewrites |
| Bash heredocs strip backslashes and choke on apostrophes | write files with the Write tool, or a small Node script |
| `sed -i` turns the CRLF docs (`PROJECT_CONTEXT.md`, `CLAUDE.md`, `README.md`) into LF | edit them with the Write/Edit tools |
| The SQLite migration runner splits on `;` | never put a semicolon in a migration comment |
| In-page modals paint under the navbar | portal to `body` |
| `backdrop-filter` / gradients / `drop-shadow` stall first draw 50–100 ms | stay inside `theme.css`'s existing safe set |
| PowerShell 5.1 has no `&&`, no ternary, no `??` | `A; if ($?) { B }` |

---

## 18. Document index

Read these when touching the matching area. The high-numbered ones are the live decisions.

| Doc | Subject | Still current? |
|---|---|---|
| `01`–`05` | architecture, database design, sync/offline, risk/scaling, roadmap | foundational; sync is aspirational |
| `06`–`11` | architecture review, DDD context map, event bus & versioning, operations resilience, migrations & release governance, **architecture freeze v1.0** | yes |
| `12`–`17` | testing strategy, architecture diagrams, deployment, backup & recovery, **coding standards**, **folder structure** | yes |
| `18` | Phase 1.5 offline completion report | historical |
| `19` | **CLAUDE.md compliance audit** — the stack-mapping table and the test baseline | **yes — read with §14** |
| `20` | **Money schema audit** — full money column inventory, paisa migration proposal | **yes — §5 is the open decision** |
| `21` | Raw material store movement gap | resolved 2026-09-26; issuing partly open |
| `22` | **Raw material information architecture** — the 8→1 workspace consolidation | implemented 2026-09-28 |
| `23` | **A bill must keep saying what its gatepass says** | implemented 2026-09-29 |
| `24` | **Machine Program** — read **§00 first** (2026-10-07), then §0 (2026-10-05) | §§1–10 are superseded but kept because the DB still carries them |
| `archive/` | Aug 2026 UI redesign notes, discount hierarchy analysis, architecture audit | historical |

---

## 19. The working method (CLAUDE.md §7, §10)

For every task:

```
Inspect  →  Identify the existing implementation  →  Reuse where possible
         →  Refactor only where needed  →  Implement  →  Verify  →  Report
```

### Before you write code

- Find where the functionality **already lives**. There is a lot of code here; assume the
  thing you need exists.
- **Never create a second implementation to bypass an existing one.** No second product
  service, second stock calculation, second QR validator, second design system, second API
  layer, second money helper.
- Check `components/shared/` and the relevant `features/*` folder for the UI piece.
- Check `packages/domain/src/constants.ts` for the status/permission/type you are about to
  type as a string literal.
- Check `shared/ipcChannels.ts` before inventing an endpoint.
- **Read the target file's header comment.** It usually states the business rule the file
  exists to protect.

### When the change touches inventory, QR, production, dispatch, returns, billing or finance

Data correctness outranks everything. Validate inputs, prevent duplicate transactions,
preserve history, respect existing identifiers, use the transaction boundary, keep related
state consistent. **If a requirement is ambiguous and the wrong guess could corrupt business
data — stop, inspect the existing business logic, and ask.**

### Before you report done

- `npm run build` clean.
- Run the affected suites and compare against the §13 baseline.
- Check for accidentally duplicated code, hardcoded design values and hardcoded endpoints.
- **Report:** what changed, which files, any refactoring, **what you actually tested**, and
  any remaining limitation. Never claim something was tested if it was not.
