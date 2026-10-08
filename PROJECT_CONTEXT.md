# 777EVA ERP — PROJECT CONTEXT

> This document is the persistent context and source of truth for the 777EVA ERP project.
>
> Read this before making architectural, database, business-logic, inventory, scanning, billing, ledger, or UI/UX changes.
>
> The actual codebase is the implementation source of truth. This document describes the intended product behavior, business rules, constraints, and design direction.

---

# 1. PROJECT OVERVIEW

## Project Name

**777EVA ERP**

The system is being developed for **777EVA / T&T Traders**, a footwear manufacturing/trading operation.

The application is an internal ERP and operational management system.

It is intended to manage:

* Raw materials
* Inventory
* Production
* QR scanning
* Dispatch
* Billing
* Sales vouchers
* Cash vouchers
* Customer ledgers
* Stock movements
* Users and permissions
* Operational logs
* Backups
* System health
* Configuration

The application should feel like a serious professional business system, not a generic CRUD application.

---

# 2. PRIMARY PRODUCT GOAL

The main objective is to replace fragmented/manual operational processes with a reliable centralized system.

The ERP must prioritize:

1. Data correctness
2. Stock correctness
3. Financial correctness
4. Simple operation for non-technical workers
5. Fast scanning
6. Clear workflows
7. Auditability
8. Reliability
9. Professional UI/UX
10. Maintainability

A visually attractive interface is important, but it must NEVER compromise business logic or operational clarity.

---

# 3. USERS

The system is used by people with different levels of computer literacy.

Some users are comfortable with software.

Others, especially workers involved in physical production/dispatch operations, may have limited computer skills.

Therefore:

* Important actions must be obvious.
* Buttons should be large enough.
* Labels should be understandable.
* Avoid unnecessary technical terminology.
* Avoid information overload.
* Minimize the number of steps required for frequent operations.
* Prefer visual identification where appropriate.
* Do not assume the operator understands database terminology.

The ERP is an operational tool first.

---

# 4. CORE DESIGN PHILOSOPHY

The system should be:

* Professional
* Clean
* Fast
* Predictable
* Minimal
* Structured
* Information-dense where useful
* Easy to operate
* Consistent

The interface should feel closer to a polished professional business application than a template/admin dashboard.

---

# 5. UI/UX DESIGN DIRECTION

## Overall Style

Preferred visual direction:

* Apple-inspired
* Professional
* Clean
* Modern
* Minimal
* Desktop-first
* Strong hierarchy
* Excellent spacing
* Clear typography
* Restrained use of color

Preferred palette:

* White
* Light gray
* Deep navy
* Black / dark gray
* Restrained green
* Restrained red

Green and red should communicate meaningful states.

Do not use color simply for decoration.

---

## DO NOT USE

Avoid:

* Neumorphism
* Claymorphism
* Glassmorphism
* Excessive gradients
* 3D cards
* Excessive shadows
* Floating blobs
* Futuristic graphics
* Decorative UI that adds no operational value
* Excessive rounded cards
* Overly colorful dashboards
* Huge unnecessary headings
* Excessive whitespace that reduces information density

The application should NOT look like an AI-generated SaaS template.

---

# 6. NAVIGATION

Current conceptual navigation:

* Dashboard
* Scanning
* Inventory
* Setup
* Billing
* Settings
* Health
* Logs
* Backup

Version indicator:

* v0.1.0

The exact implementation may change if the existing application architecture requires it, but navigation should remain logically organized.

---

# 7. QR / SCANNING SYSTEM

QR scanning is a major part of the ERP.

The system is designed around physical scanners (2D imagers, which read QR codes).

Current hardware direction:

* Raspberry Pi 5 devices
* Wi-Fi network
* Direct scanner connection
* No scanner display required
* No Bluetooth dependency
* Cloud + local backlog/sync architecture is desired

A Honeywell Xenon 1902 scanner has been used/tested.

Scanner ID example:

`L14278`

---

# 8. QR FORMAT

The desired internal QR/code format is conceptually similar to:

`ID: SK6_BLUE_7/10_001`

Example components:

* Article: SK6
* Color: BLUE
* Size: 7/10
* Serial: 001

The exact final encoded format can evolve based on implementation constraints.

Important:

The QR code must be able to uniquely identify the required operational item.

The identity string above is the whole QR payload. Article, colour, size and serial are read
back from the registry (`qr_codes`), never trusted from the label, so a reprinted or
relabelled carton can never carry stale product data.

Do NOT force the business into EAN-13 merely because it is a common retail barcode.

---

# 9. CODE TECHNOLOGY DECISIONS

**Current decision: QR.** The operational carton label is a QR code, and the QR Generator,
QR Management and every label print produce QR codes. Code128 barcodes are no longer issued.

Previously considered formats:

### EAN-13

Rejected as the primary internal identity system because it is too restrictive for the required internal information.

### Code 128

Used until the switch to QR. It works, but it is a long, purely horizontal symbol: a carton
identity needed most of a 3in sticker, it can only be read across its width, and it carries no
error correction, so a scuffed or partly torn label stops scanning.

### QR — current

Chosen for the operational label:

* Square, so a long identity fits a small area of the sticker
* Readable from any orientation
* Built-in error correction (level M recovers roughly 15% of a damaged symbol)
* Room to carry more data later without changing the symbology

The earlier concerns (physical size, scanning behaviour, character loss) are addressed by
printing at 1.3in square with a 4-module quiet zone — about 1mm per module, comfortably above
what a handheld imager needs — and by keeping the payload to the registered identity only.

The project should prioritize a robust, reliable code format suited to internal operations.

---

# 10. PRODUCTION SCANNING

Production scanning represents stock entering/being recorded in the system.

Conceptually:

**Production → +IN**

A production scan should increase the appropriate inventory/stock quantity.

Production and dispatch are separate operational roles/workstations.

There may be two physically separated Raspberry Pi scanning stations.

---

# 11. DISPATCH SCANNING

Dispatch represents stock leaving the available stock.

Conceptually:

**Dispatch → -OUT**

A dispatch scan should decrease the relevant stock quantity.

The system must prevent invalid stock movement.

For example:

* Do not allow dispatching unavailable stock.
* Do not silently create negative stock.
* Do not duplicate a scan.
* Do not lose a scan because of UI state.

---

# 12. OPERATIONAL DAY

The business does not necessarily operate on a conventional midnight-to-midnight operational day.

The operational day has historically been based around approximately:

**6:00 AM → 6:00 AM**

This matters for:

* Production
* Dispatch
* Daily reporting
* Operational totals
* Scan grouping
* Logs

Do not assume a calendar date automatically represents the business operational day.

---

# 13. EXPECTED SCANNING VOLUME

The system should be designed with the possibility of approximately:

**10,000 scans/day**

The architecture should therefore avoid unnecessarily expensive operations for every scan.

Scanning must be fast and reliable.

The dashboard/laptop should not need to remain continuously open for the physical scanning process to function.

---

# 14. OFFLINE / SYNC REQUIREMENT

The scanning system should support reliable operation even when connectivity is temporarily unavailable.

Desired conceptual architecture:

**Scanner → Local device/backlog → Sync → Central/cloud system**

Important requirements:

* Scans should not simply disappear if the network fails.
* Local backlog should preserve unsynchronized events.
* Synchronization should be recoverable.
* Duplicate synchronization must be prevented.
* Event history should be auditable.

Do not implement destructive synchronization logic.

---

# 15. SCAN DATA MODEL

The system has conceptually included:

### `scans`

Current/operational scan records.

### `scan_history`

Historical/audit records.

The exact schema in the codebase is authoritative.

Do not rename or restructure these tables merely for aesthetic reasons.

Any schema modification must consider:

* Existing records
* Foreign keys
* Historical records
* Synchronization
* Reporting
* Inventory calculations

---

# 16. INVENTORY PRINCIPLE

Inventory must be event-driven and auditable wherever practical.

The system should be able to answer:

* What stock exists?
* How much exists?
* Where did it come from?
* When did it enter?
* When did it leave?
* Which transaction changed it?
* Who performed the action?
* What was the previous quantity?
* What is the resulting quantity?

Never make inventory a mysterious manually edited number.

---

# 17. RAW MATERIAL INVENTORY

Raw materials are a major part of the ERP.

Examples include:

### RUBBER UPPER

* SK12 BLACK 7/10
* SK12 BLUE 7/10
* SK6 RED 4/6
* SK6 RED 7/10

### BUCKLE

* D BUCKLE LARGE
* D BUCKLE SMALL
* FLOWER BUCKLE

### SHEETS

* 4M RAGZINE
* 6MM SHEET

---

# 18. IMPORTANT RAW MATERIAL MODEL

Do NOT assume that the category itself uniquely identifies an item.

For example:

`RUBBER UPPER`

is a category/type.

It can contain many variants.

Example:

`RUBBER UPPER`
→ SK12 BLACK 7/10
→ SK12 BLUE 7/10
→ SK6 RED 4/6
→ SK6 RED 7/10

Therefore:

**Category ≠ Item Identity**

---

# 19. RAW MATERIAL ATTRIBUTES

Different categories require different dimensions.

For example:

### RUBBER UPPER

Relevant dimensions may include:

* Article
* Color
* Size

### BUCKLE

Relevant dimensions may include:

* Type/design
* Size

### SHEETS

Relevant dimensions may include:

* Specification
* Thickness
* Length
* Unit

The system should support category-specific attributes without creating an unnecessarily rigid hierarchy.

---

# 20. RAW MATERIAL SEARCH

Users should be able to search by meaningful dimensions.

Examples of intended queries:

* Total Rubber Upper
* SK6 upper
* 7/10 upper
* Red SK12
* Blue upper
* D-buckle pairs
* Sheets in meters

Search should understand the item's attributes rather than requiring users to remember an exact database name.

---

# 21. ITEM NAME INCONSISTENCY

Real suppliers/users may refer to the same material differently.

Examples:

`UPPER SK12 BLACK BLUE 4/6`

`UPPER SK12 BLACK 4/6`

`UPPER SK12 BLUE 4/6`

`black sky`

`sk12 4/6 red`

`sk12 4-6 red`

`sk12 red 4/6`

The system must not rely solely on exact string matching.

Aliases / normalized attributes / structured search should be considered where appropriate.

---

# 22. NORMALIZATION

User-entered material information should be normalized where practical.

Preferred behavior:

* Convert standardized fields to uppercase.
* Normalize obvious formatting differences.
* Treat equivalent size formats consistently where business rules allow.
* Separate meaningful attributes from arbitrary free text.

Examples:

`red` → `RED`

`Sk12` → `SK12`

`4-6` may normalize to the standardized representation used by the system.

Do not destroy meaningful supplier descriptions merely for formatting.

---

# 23. PREVIOUS RAW MATERIAL PROBLEM

A previous approach treated item identity too rigidly and resulted in problems such as:

`RM-000001 · RUBBER UPPER RED — SK12`

followed by:

`ITEM ALREADY EXIST`

when trying to create another variant.

This approach is conceptually wrong for the intended business model.

Multiple variants can belong to the same category.

The system must distinguish between:

**Category**

and

**Variant / Item**

without forcing every category to be unique.

---

# 24. UNITS

Examples of operational units:

* PAIR
* DOZEN
* RULE
* METER

Example business rule:

**1 RULE = 100 METERS**

Unit conversion should be explicit and controlled.

Do not silently convert units without preserving the original transaction unit where auditability requires it.

---

# 25. RAW MATERIAL EXAMPLE DATA

Target conceptual inventory:

## RUBBER UPPER

| Item            | Quantity | Unit  |
| --------------- | -------: | ----- |
| SK12 BLACK 7/10 |       20 | DOZEN |
| SK12 BLUE 7/10  |       10 | DOZEN |
| SK6 RED 4/6     |       20 | DOZEN |
| SK6 RED 7/10    |       40 | DOZEN |

## BUCKLE

| Item           | Quantity | Unit  |
| -------------- | -------: | ----- |
| D BUCKLE LARGE |       10 | PAIRS |
| D BUCKLE SMALL |       20 | PAIRS |
| FLOWER BUCKLE  |       30 | PAIRS |

## SHEETS

| Item       | Quantity | Unit |
| ---------- | -------: | ---- |
| 4M RAGZINE |        2 | RULE |
| 6MM SHEET  |        4 | RULE |

Conversion:

`1 RULE = 100 METERS`

---

# 26. ITEM CATEGORY SYSTEM

The application previously included an Item Categories / Raw Material Master concept.

Example:

`RUBBER UPPER`

Attributes:

* Article
* Color
* Size

Attribute types may include:

* TEXT
* NUMBER
* DROPDOWN
* UNIT

There may also be flags such as:

* Required
* Searchable

However, do not preserve a previous hierarchy simply because it existed.

The intended model is:

**Category + structured attributes → material variant**

---

# 27. BILLING SYSTEM

Billing is a core ERP function.

The system should support:

* Sales vouchers
* Voucher list
* Cash vouchers
* Cash voucher list
* Customer ledger
* Customer balance
* Dispatch-related billing

---

# 28. LIVE DISPATCH FLOW

Desired conceptual flow:

1. User opens Live Dispatch.
2. Scanner becomes the primary input.
3. User selects/opens the appropriate bill/article context.
4. Scanning begins.
5. Each valid scan affects the current/pending dispatch quantity.
6. Available stock is checked.
7. Pending quantity is visible.
8. When complete, the bill can be finalized.
9. Finalization records the appropriate stock movement and financial transaction.

The scanner should not feel like an optional secondary feature.

It is the main operational input.

---

# 29. DISPATCH UI

Dispatch should prioritize operational speed.

For workers:

* Large scan state
* Clear article/color/size
* Clear quantity
* Clear stock availability
* Clear errors
* Minimal unnecessary text

Do not bury scanning behind complicated navigation.

---

# 29A. GATEPASS (STORE RESERVATION DOCUMENT)

A Gatepass is an operational document that **reserves store stock for a party**. It never moves stock; the Store Move Out scan made *for* it does.

Flow:

```text
PRODUCT MASTER → STORE STOCK (In Store) → GATEPASS (reservation) → plain Store Move Out scan (reconciled to the oldest open Gatepass line) → gate → Live Dispatch
```

Two stock figures, never confused (`@erp/domain/gatepassStock.ts` is the single source of the formulas; 2026-09-21):

```text
Current Stock    = stock_projection_by_location at WAREHOUSE            (physical; changed only by a scan)
Reserved         = Σ over CREATED gatepass lines of (quantity − dispatched from store)
Reflected Stock  = Current Stock − Reserved                             (what a NEW gatepass may take)
dispatched from store (per line) = COUNT(STORE_EXIT) − COUNT(STORE_ENTRY bring-backs) in production_events
                                   WHERE gatepass_id = line's gatepass AND product_variant_id = line's variant
```

Worked example: Current 5 → GP1 = 3 → Current 5 / Reflected 2 → GP2 = 1 → Current 5 / Reflected 1 → GP3 = 2 is **refused** → three plain Store Move Out scans of RED 7/10 are counted against GP1 → Current 2 / Reflected 1 → a fourth is counted against GP2 → Current 1 / Reflected 1. Covered end to end by `packages/data/src/gatepassReservations.test.ts`.

Rules (implemented — see `packages/application/src/gatepassUseCases.ts`, `packages/data/src/sqliteDatabase.ts` "Gatepass" section, `apps/desktop/src/renderer/pages/GatepassPage.tsx`, `features/gatepass/`, `GatepassListPage.tsx`, `utils/gatepassGrid.ts`, `utils/gatepassPrint.ts`):

* **Create screen = article cards + live summary (2026-09-19).** Left column: party (with current balance), then one collapsible card per *Article + Size* listing every colour the store holds with its In Store cartons and a − / + quantity box; one card open at a time; the same article + size cannot be added twice (picking it again re-opens it). Right column: a sticky summary of every article / colour / quantity with article totals and the grand total, read from the same draft (`features/gatepass/gatepassDraft.ts`) as the cards. Quantities above Reflected Stock are refused inline ("Only N available (Reflected Stock)") and block Create. After Create the stored document replaces the draft on screen (read-only, Print / Open in list), and the header's ‹ GP-n › Load walks through stored documents by number (`getGatepassByNumber` / `erp:get-gatepass-by-number`; the highest number comes from `listGatepasses` page 1) without disturbing a draft in progress. The detail view and the printout keep the book's shape: one grid, one row per *Article + Size*, one column per *colour*, a quantity in each cell, row totals (تعداد) on the right, colour totals underneath. Colours are whatever the store holds (natural order) — never a hard-coded list. The whole In Store stock is loaded in one read (`listStoreStock` / `erp:list-gatepass-store-stock`); a find box narrows rows by article/size but never hides a row that already carries a quantity.
* Header fields mirror the book: Party (بل بنام), GP No. (بل نمبر, assigned on create), Date (تاریخ), **Bilty No.** (بلٹی نمبر, `gatepasses.bilty_number`) and **Via** (بزریعہ, `gatepasses.transport_via`) — both optional, migration `027_gatepass_transport`; when empty they print as blank lines to be written in by hand. Remarks is free text.
* Party comes from the Party Master; article/colour/size come from the Product Master (`product_variants.id` is the line identity, with article/colour/size snapshots). One Gatepass carries any number of articles, and every article + colour + size stays on its own line.
* Every colour row on the create screen shows **Current Stock · Reserved · Reflected Stock**; the quantity box is capped at Reflected Stock (never labelled plain "Stock"). `CreateGatepassUseCase` re-reads Current Stock and Reserved for every line inside the `BEGIN IMMEDIATE` write transaction (`getStoreStockForVariants`) and refuses the whole document if any line exceeds Reflected Stock (`INSUFFICIENT_STOCK`, or `STOCK_CHANGED` when the figure moved since it was shown — the UI sends `reflectedStockSeen`). Two clerks racing for the last carton: exactly one succeeds. Nothing is cached: `gatepass_lines` stores only the requested quantity; Reserved / Reflected / dispatched are derived every time (`packages/data/src/database/gatepass.ts`, `LINE_DISPATCHED_SQL`).
* Creating a Gatepass **never** changes a QR status or location, writes a `production_events` row, touches a stock projection, assigns QR codes, or creates a voucher / ledger entry. Physical movement is recorded only by Store Move Out and Live Dispatch scans.
* **Reconciliation (2026-09-22).** The Store Move Out station is generic — the operator scans, nothing about a Gatepass is asked, shown or required. Inside the scan's own transaction, after the guarded status move, `StoreExitScanUseCase` asks `findOldestOutstandingGatepassLine(product_variant_id)` for the oldest CREATED gatepass line (lowest gatepass number) that still owes that exact variant and writes its id on the STORE_EXIT event (`production_events.gatepass_id`, migration `034_gatepass_store_exit_attribution`); with nothing reserved the event carries null and the carton moves out anyway. Deterministic FIFO on the variant identity, never a timestamp match and never an operator choice; the reservation never blocks a physical move. One transaction: if the reconciliation read fails the whole scan rolls back (the carton stays In Store). Stock is decremented exactly once, by the existing `moveStockToGate`. A carton brought back from the gate (STORE_ENTRY from TO_GATE) carries the gatepass id of *its own* latest STORE_EXIT (`findGatepassOfLastStoreExit`), the compensating record that makes the line outstanding again. The IPC log records which gatepass each scan was counted against.
* Cancellation releases only what is still outstanding (Reserved counts CREATED documents only); cartons already moved out stay moved out, and the audit row / result state `releasedQuantity` and `dispatchedFromStoreQuantity`. There is no "completed" status: a document whose lines are all moved out simply drops off the Store Move Out list; `getGatepass` / `listGatepasses` expose `dispatchedFromStoreQuantity` and `outstandingQuantity` per line and per document.
* Numbering: `gatepasses.gatepass_number` (`MAX + 1` under the transaction), displayed as `GP-000123`.
* Status is a document status only: `CREATED` → `CANCELLED` (lines kept, cancelled_at/by/reason recorded). Never `AT GATE` / `DISPATCHED` — those belong to QRs.
* Audit: `GATEPASS_CREATED` / `GATEPASS_CANCELLED` rows in `audit_log` (written in the same transaction) plus the structured application log.
* Permissions: `gatepass` (view / create / print) and `gatepass-cancel`. Built-in role: Gatepass Clerk.
* **Gatepass → Sale Voucher (2026-09-20).** Creating a gatepass writes a typed notice (`user_notifications.kind = GATEPASS_CREATED`, `entity_id` = gatepass id) to every approved user with the `sale-voucher-form` permission and every administrator, in the same transaction (`CreateGatepassUseCase.notifyBilling` port → `SqliteDatabase.notifyUsersWithPermission`). Clicking it opens the Sale Voucher screen with `fromGatepassId`: the form pre-fills party, date (gatepass date), remarks (`Gatepass GP-n · Bilty … · via …`) and one line per gatepass line in dozens (cartons ÷ 2) with the variant's NORMAL price and the party's resolved discount — nothing is written until Save. `createSaleVoucher({ gatepassId })` stores `sale_vouchers.gatepass_id` (migration `031_gatepass_billing_link`); it refuses `GATEPASS_NOT_FOUND` / `GATEPASS_CANCELLED` / `GATEPASS_ALREADY_BILLED` (one live bill per gatepass, backed by a partial unique index), and the form opens the existing bill instead. Cancelling a gatepass writes a `GATEPASS_CANCELLED` notice: CRITICAL ("delete Sale Voucher #n") when a live bill exists, WARNING otherwise; the shell toasts CRITICAL/WARNING notices once per session, the bell shows them in red/amber, and the bill shows a red banner with a Delete button while `gatepassStatus = CANCELLED`. `utils/saleVoucherPrint.ts` prints the bill (basic layout — no paper reference yet).
* Store Move Out scans are linked to gatepasses through `production_events.gatepass_id` (see "Reconciliation" above); gate dispatch scans still reference sale vouchers via `dispatch_sessions`. Counts are always derived from real scan events — never from a manually edited status. Known gap: Live Dispatch may still dispatch a carton straight from WAREHOUSE (skipping Store Move Out); that lowers Current Stock without any reconciliation.

---

# 30. BILL STRUCTURE

A bill can contain multiple line items.

Conceptually a line may include:

* Article
* Group/category
* Size
* Quantity
* Rate
* Discount

Example:

| Article | Group     | Size | Qty | Rate | Discount |
| ------- | --------- | ---- | --: | ---: | -------: |
| SK6     | EVR GENTS | 7/10 | 0.5 |  650 |      240 |

The actual database structure should be inspected before implementation.

---

# 31. LEDGER

The customer ledger must be understandable at a glance.

Core columns:

* Date
* Voucher #
* Particulars
* Debit
* Credit
* Balance

The running balance must be mathematically correct.

Financial data should never depend solely on UI calculations.

---

# 32. LEDGER DESCRIPTIONS

Ledger particulars should contain enough information to identify the transaction without becoming unnecessarily verbose.

A sale line may include:

* Article
* Group
* Size
* Quantity
* Rate
* Discount

The description should be human-readable.

Example conceptual format:

`SK6 · EVR GENTS · 7/10 · Qty 0.5 · Rate 650 · Discount 240`

The exact final formatting can be refined later.

---

# 33. MULTIPLE PAYMENTS

The billing/ledger model should support situations where:

* A customer pays multiple times against one outstanding transaction.
* Multiple payments may occur on different dates.
* One voucher can therefore have several subsequent payment transactions.

Do not assume:

**1 invoice = 1 payment**

The ledger must represent real financial movement.

---

# 34. CUSTOMER BALANCE

Balance must be derived from ledger transactions according to the established debit/credit rules.

Never allow the UI to display a balance that differs from the underlying transaction history.

---

# 35. OPENING BALANCE

Known business data includes an opening ledger balance dated:

**14/07/2026**

Amount:

**1,705,685**

This should be treated as business data/configuration only if it exists in the current project.

Do not hardcode it into application logic.

---

# 36. RATE LIST

The business has approximately:

**30–40 articles**

with different:

* Sizes
* Prices
* Article information
* Images/logos

The rate list should remain compact and easy to maintain.

Potential display information:

* Picture
* Article
* Size
* Price
* Logo

Do not create an unnecessarily complicated rate-management workflow.

---

# 37. VOUCHERS

The billing area includes conceptual sections such as:

### Sales

* Sale Vouchers
* Voucher List

### Cash

* Cash Vouchers
* Cash Voucher List

### Customer

* Customer Ledger
* Balance

The actual implementation may differ based on the existing codebase.

---

# 38. ADMIN NOTIFICATIONS

Admin-only requests/notifications may be represented through a bell/notification mechanism.

Requirements:

* Read/unread state
* Admin visibility
* Clear notification purpose

Do not turn notifications into a generic noisy activity feed.

---

# 39. ROLES AND PERMISSIONS

There are at least two permanent operational roles around production/dispatch.

The exact permission model should be determined from the current codebase.

General principle:

Users should only be able to perform actions appropriate to their role.

Examples:

* Operational worker
* Admin

Administrative actions should not accidentally be exposed to normal scanning operators.

---

# 40. AUDITABILITY

Important actions should be traceable.

Especially:

* Stock changes
* Scans
* Voucher creation
* Voucher edits
* Payments
* Inventory adjustments
* Configuration changes
* User/permission changes

Avoid destructive updates where history matters.

---

# 41. DATA INTEGRITY

This is an ERP.

Correctness is more important than convenience.

Never:

* Silently overwrite financial transactions
* Create duplicate scans
* Create duplicate payments
* Allow unexplained negative stock
* Delete historical transactions casually
* Change identifiers without migration planning
* Modify database structure without considering existing records
* Introduce inconsistent units

---

# 42. ERROR HANDLING

Errors should be understandable to the person operating the system.

Bad:

`ForeignKeyViolation: constraint xyz failed`

Better:

`This item cannot be removed because it has existing stock transactions.`

Technical details can still be logged for developers.

Users should receive operationally useful messages.

---

# 43. SEARCH EXPERIENCE

Search should be forgiving but precise.

Users should not have to remember exact capitalization or formatting.

Where practical:

* Case-insensitive search
* Attribute-based filtering
* Alias support
* Partial matching
* Structured filters

But avoid fuzzy matching that creates dangerous ambiguity in inventory or financial transactions.

If multiple items match, show the user enough information to select the correct one.

---

# 44. INVENTORY IDENTIFICATION

An item should be identifiable through meaningful attributes.

Do not rely on arbitrary IDs such as:

`RM-000001`

as the primary human-facing identity.

Internal IDs can exist in the database.

But operators should primarily see meaningful business information.

Example:

`RUBBER UPPER · SK12 · BLACK · 7/10`

---

# 45. UI INFORMATION HIERARCHY

Every screen should answer:

1. Where am I?
2. What am I looking at?
3. What is the important information?
4. What action should I take?
5. What happened after I took it?

Avoid screens where everything has equal visual importance.

---

# 46. TABLE DESIGN

Tables are important for ERP workflows.

Preferred:

* Clear column hierarchy
* Compact rows
* Good alignment
* Numeric values aligned consistently
* Strong headers
* Search/filter controls
* Useful sorting
* Clear empty states
* Sticky headers where appropriate
* Pagination/virtualization where necessary

Avoid:

* Huge row heights
* Excessive card wrappers
* Decorative table elements
* Too many columns without prioritization

---

# 47. FORMS

Forms should:

* Group related fields
* Use clear labels
* Show required fields
* Provide sensible defaults
* Validate immediately where appropriate
* Avoid unnecessary fields
* Preserve entered data after validation errors

All standardized business text should follow the system's normalization rules.

---

# 48. MODALS

Use modals for focused actions.

Do not put entire complicated workflows inside tiny modals.

If a workflow is complex, use a dedicated page or properly structured panel.

---

# 49. DASHBOARD

The dashboard should prioritize useful operational information.

Potential information:

* Current stock indicators
* Today's scans
* Production
* Dispatch
* Pending operations
* Financial summary
* Alerts
* System health

Do not fill the dashboard with meaningless charts simply because dashboards usually contain charts.

---

# 50. HEALTH / SYSTEM MONITORING

A Health section exists conceptually to help monitor system status.

Potential areas:

* Database
* Sync
* Scanner connectivity
* Local backlog
* Cloud connectivity
* Errors
* Device status

Health information should be actionable.

---

# 51. LOGS

Logs should provide enough information to troubleshoot operational problems.

Useful information may include:

* Timestamp
* User/device
* Action
* Entity
* Result
* Error
* Relevant identifier

Logs should not become the same thing as user-facing notifications.

---

# 52. BACKUP

Backup is a first-class ERP concern.

The system should provide a clear backup strategy.

Important data includes:

* Database
* Transactions
* Inventory history
* Scans
* Financial records
* Configuration where appropriate

Do not assume source code backup equals business data backup.

---

# 53. PERFORMANCE

Expected operational scale is not enormous by enterprise standards, but the system must be responsive.

Important areas:

* QR scans
* Inventory queries
* Ledger queries
* Search
* Voucher lists
* Historical scan data

Avoid unnecessary database queries.

Avoid fetching massive datasets when a filtered query is sufficient.

---

# 54. DATABASE PRINCIPLES

The database should be designed around:

* Clear entities
* Stable IDs
* Relationships
* Transaction history
* Constraints
* Referential integrity
* Auditability

Do not duplicate the same business fact in many unrelated places unless there is a deliberate reason.

---

# 55. FRONTEND PRINCIPLES

Frontend should:

* Reuse components
* Reuse design tokens
* Avoid duplicated business logic
* Keep API/database logic separated appropriately
* Handle loading/error/empty states
* Provide immediate feedback for important operations

Do not solve a backend/data problem purely with frontend state.

---

# 56. BACKEND PRINCIPLES

Backend should be responsible for important business rules.

Especially:

* Inventory changes
* Financial transactions
* Permissions
* Validation
* Stock availability
* Transaction integrity

Do not trust the frontend to enforce critical business rules.

---

# 57. CHANGE MANAGEMENT

Before changing existing functionality:

1. Locate the relevant implementation.
2. Read the surrounding code.
3. Understand dependencies.
4. Identify database impact.
5. Identify UI impact.
6. Identify business-logic impact.
7. Make the smallest appropriate change.
8. Verify related workflows.

Do not refactor unrelated code during a feature change unless there is a strong reason.

---

# 58. DO NOT ASSUME OLD IMPLEMENTATION IS CORRECT

Existing code may contain bugs.

This document describes intended behavior, not a guarantee that current code is correct.

If code conflicts with the business rules in this document:

1. Identify the conflict.
2. Explain it.
3. Do not silently change behavior.
4. Ask/confirm when the change could affect existing data.

---

# 59. DO NOT ASSUME THIS DOCUMENT IS MORE AUTHORITATIVE THAN THE CODE

There are three levels of truth:

### Level 1 — Actual business decision

What the owner/operator has explicitly decided.

### Level 2 — This project context document

The documented intended behavior.

### Level 3 — Existing implementation

What the current code actually does.

When these conflict, identify the conflict rather than pretending they are consistent.

---

# 60. CURRENT DEVELOPMENT STATUS

The project is actively evolving.

Some areas may be:

* Fully implemented
* Partially implemented
* Prototypes
* Temporary
* Being redesigned

Do not assume every existing screen represents the final product design.

In particular, UI/UX is actively being refined.

---

# 61. UI/UX REDESIGN PRINCIPLE

When improving a screen:

Do not merely make it prettier.

Improve:

* Structure
* Information hierarchy
* Workflow
* Readability
* Action placement
* Searchability
* Error prevention
* Visual consistency
* Operational efficiency

A redesign should solve the underlying UX problem.

---

# 62. IMPORTANT CURRENT UI/UX DIRECTION

The application should feel like a coherent product.

For every new screen, ask:

* Does this look like it belongs to 777EVA ERP?
* Is the primary action obvious?
* Can an operator understand it quickly?
* Is the information hierarchy correct?
* Are numbers easy to scan?
* Are dangerous actions clearly distinguished?
* Is unnecessary UI removed?
* Does it follow existing patterns?

---

# 63. DEVELOPMENT COMMUNICATION RULES

When working with the project owner:

Do not respond with generic statements such as:

> "Sure, I'll improve the UI."

Instead:

* Understand the exact problem.
* Inspect the implementation.
* Explain what is wrong.
* Propose a concrete solution.
* Implement only after understanding the implications.

When a task is ambiguous, use the existing project context to resolve obvious ambiguity instead of repeatedly asking for information already established.

---

# 64. CLAUDE / AI WORKING RULES

When working on this repository:

### ALWAYS

* Read relevant existing files first.
* Follow existing architecture.
* Preserve working functionality.
* Consider database integrity.
* Consider business logic.
* Check related components.
* Check imports/dependencies.
* Check side effects.
* Keep changes focused.
* Explain important architectural decisions.

### NEVER

* Rewrite the entire project unnecessarily.
* Replace architecture merely because another architecture is fashionable.
* Create duplicate components when reusable components already exist.
* Create duplicate database concepts.
* Hardcode business data into UI.
* Remove historical data casually.
* Change financial logic without understanding it.
* Change inventory logic without understanding stock movement.
* Introduce unnecessary dependencies.
* Make large unrelated refactors during a small feature request.

---

# 65. WHEN IMPLEMENTING A NEW FEATURE

Use this sequence:

### Step 1 — Understand

Read the relevant files.

### Step 2 — Trace

Follow the data flow.

### Step 3 — Identify

Determine which components, APIs, database tables, types, and services are involved.

### Step 4 — Plan

Describe the intended change briefly.

### Step 5 — Implement

Make the smallest correct implementation.

### Step 6 — Verify

Check:

* Type errors
* Runtime errors
* Database issues
* Existing workflows
* Edge cases
* UI states

### Step 7 — Summarize

Tell the project owner:

* What changed
* Which files changed
* Why
* Any important caveats
* Anything that still needs testing

---

# 66. WHEN MODIFYING DATABASE STRUCTURE

Before a migration:

* Inspect current schema.
* Inspect existing data.
* Check dependencies.
* Check foreign keys.
* Check indexes.
* Check application queries.
* Consider backward compatibility.
* Consider migration rollback/recovery.
* Consider historical records.

Never perform a destructive schema change casually.

---

# 67. WHEN MODIFYING INVENTORY

Before changing inventory logic:

Understand:

* Stock source
* Stock destination
* Unit
* Quantity
* Transaction/event
* User/device
* Timestamp
* Existing stock
* Historical movement

Inventory changes should be explainable after the fact.

---

# 68. WHEN MODIFYING FINANCIAL LOGIC

Before changing billing or ledger logic:

Understand:

* Debit
* Credit
* Opening balance
* Voucher
* Payment
* Outstanding balance
* Discount
* Rate
* Quantity
* Date
* Customer

Financial calculations must be deterministic and auditable.

---

# 69. WHEN MODIFYING SCANNING

Before changing scanning:

Understand:

* Scanner input
* QR parsing
* Item identification
* Duplicate handling
* Inventory effect
* Local persistence
* Synchronization
* Error handling
* History
* Device identification

Scanning must remain reliable even under real-world operational conditions.

---

# 70. REAL-WORLD OPERATING PRINCIPLE

This is not merely a demo project.

The system will be used for actual business operations.

Therefore:

**Correctness > cleverness**

**Reliability > novelty**

**Clarity > decoration**

**Auditability > convenience**

**Simple workflow > feature overload**

---

# 71. IMPORTANT OPEN DECISIONS

The following should NOT be assumed to be permanently finalized unless confirmed in the current code/project discussion:

* Exact final QR payload beyond the identity string
* Final cloud architecture
* Exact offline synchronization implementation
* Final authentication model
* Exact role/permission matrix
* Final database schema
* Final production workflow
* Final dispatch workflow
* Final accounting/debit-credit conventions
* Exact unit conversion implementation
* Final UI navigation structure
* Final deployment architecture

When these areas are encountered, inspect the current project and existing decisions before choosing an implementation.

---

# 72. SOURCE-OF-TRUTH RULE

When implementing anything:

**Existing code tells you what currently exists.**

**This document tells you the intended business/product direction.**

**The project owner's latest explicit instruction overrides older assumptions.**

If the latest instruction conflicts with this document, update the implementation according to the latest confirmed decision and consider updating this document as well.

---

# 73. FINAL PRINCIPLE

The goal is not to build a collection of screens.

The goal is to build a reliable ERP that accurately represents the real operations of 777EVA / T&T Traders.

Every feature should ultimately make one or more of these things better:

* Stock accuracy
* Operational speed
* Financial accuracy
* Traceability
* Ease of use
* Reliability
* Decision making

If a feature does not meaningfully improve the system, question whether it is necessary.

---

# END OF PROJECT CONTEXT

Before making substantial changes, read this document and the relevant source code.

Do not ask the project owner to repeatedly explain information already contained here.

However, always verify assumptions against the actual current implementation before making changes.
