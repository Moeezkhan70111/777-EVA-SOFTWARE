# Raw Material — Information Architecture

**Date:** 2026-09-28
**Status:** Implemented 2026-09-28.
**Scope:** The Raw Material module's user-facing structure. No change to the stock model, the
QR identity model, the scan use cases, the database schema, or the finished-goods module.

---

## 1. What the module actually is

Eight navigation destinations sit on top of **one** stock model and **one** QR identity model.

### One stock model (verified)

`inventory_stock_balances` holds exactly one row per material — a quantity and the unit it is
held in. Three things write it, all through `applyRawMaterialStockChange` /
`adjustInventoryStock`:

| Writer | Direction | Where from |
|---|---|---|
| Raw Material Input scan (`STORE_ENTRY`) | `+ packing quantity` | `ReceiveRawMaterialScanUseCase` |
| Raw Material Output scan (`STORE_EXIT`) | `- packing quantity` | `IssueRawMaterialScanUseCase` |
| Adjust Stock / opening stock | `± typed amount` | `adjustInventoryStock` |

Every one of them also appends to `inventory_stock_events`. That table is the complete movement
ledger for a material, and **nothing in the app reads it today** — there is no read API at all.

**Purchase vouchers do not touch stock.** `createPurchaseVoucher` writes
`purchase_vouchers` + `purchase_voucher_line_items` and nothing else. So "Raw Material
Receipts" is a *commercial* record (what we bought and owe for), and the scans are the
*physical* record (what is on the shelf). They are two different facts about the same delivery,
and the UI has never said so.

### One QR identity model (verified)

`RM_PARTYTOKEN_ITEMTOKEN_SERIAL` (e.g. `RM_6_42_6` — the numeric tail of the party/item code,
unpadded; shortened 2026-09-30 from the original `RMQR_PARTYCODE_ITEMCODE_SERIAL`, still
accepted when scanning so labels already printed keep working), built by `buildRawMaterialQrId`,
registered in `raw_material_qrs`,
moved through `GENERATED → IN_STORE → ISSUED`, journalled in `raw_material_qr_events`, and read
back by QR Management and QR Journey (which already understand raw material). Packing is
**snapshotted onto each label when it is printed**, falling back to the material's current
packing for labels printed before packing was configured.

### The ordering that the UI never shows

1. Category + attributes + units exist → 2. material created → 3. **packing + route set** →
4. labels generated (packing is snapshotted here) → 5. Input scan → 6. Output scan.

Step 3 must precede step 4 for the snapshot to be right, and a material with no packing cannot
be scanned at all. Today steps 2, 3 and 4 are three separate destinations in two different nav
groups, with no indication that the order matters.

---

## 2. Current structure

| Page | Route | Nav group | What it really does |
|---|---|---|---|
| Add Raw Material | `raw-materials` | Inventory | Create-only form. No list, no edit. |
| Raw Material Stock | `raw-material-stock` | Inventory | Search/filter list + Adjust Stock + Cost Price. |
| Raw Material Receipts | `raw-material-ledger` | Inventory | Read-only browser over **purchase vouchers**. |
| Raw Material QR Generator | `raw-material-qr-generator` | Inventory | Supplier + material + qty → labels + batch history. |
| Raw Material Packing | `raw-material-packing` | Inventory | Work sections + per-material packing + hop route. |
| Raw Material Input | `raw-material-input` | Store | Scan station, supplier session, printed receipt. |
| Raw Material Output | `raw-material-output` | Store | Scan station, auto session, printed issue slip. |
| Inventory Categories | `inventory-categories` | Settings | Categories, attribute library, units, conversions. |

### Duplication found

* `loadLookups` (categories + units) written twice — Master page and Stock page.
* The **Add Unit** modal written twice, identically — Master page and Categories page.
* Adding a dropdown option written twice — Master page modal and Categories inline row.
* Attribute field rendering written twice — `renderCreateField` and `renderFilterControl`.
* `formatQuantity` / `fmtQty` — the same 3-decimal helper, twice.
* The Stock table shows **Item**, **Category** and **Attributes** as three columns, but
  `display_name` is literally `category — attr — attr — attr`. Two of the three columns are the
  first column re-printed.
* A bespoke party combobox in the Receipts page duplicates `SearchableCombobox`.

The four scan stations already share `features/scanStation` correctly — no duplication there.

### Capability with no UI

`listRawMaterialReceivingSessions` is implemented, wired through IPC and preload, typed on the
renderer API — and called from nowhere. Past deliveries cannot be looked up or re-printed.

---

## 3. Proposed structure

**One workspace, two scan stations.**

```
Inventory ▸ Raw Material              ← the workspace (route: raw-material)
              ├ Stock      (default)
              ├ Labels
              ├ Receipts
              └ Setup
Store     ▸ Raw Material Input        ← unchanged full-screen scanner
Store     ▸ Raw Material Output       ← unchanged full-screen scanner
Settings  ▸ Raw Material Setup        ← deep-link into the workspace's Setup tab
```

Raw-material nav rows: **8 → 4**. For the office operator, one destination instead of six.

### Per-page disposition

| Current page | Disposition | Why |
|---|---|---|
| **Raw Material Stock** | **KEEP — becomes the main workspace (Stock tab)** | It is the only screen that answers the question the operator actually arrives with. Everything else is something you do *to* a material you found here. |
| **Add Raw Material** | **CONVERT TO MODAL** (`+ New Material` on the Stock tab) | A create-only form with no list is half a screen. The list it was missing is the Stock tab. |
| **Raw Material Packing** | **CONVERT TO DRAWER SECTION** (per material) + Destinations move to Setup | Packing and route are properties of *one material*. Editing them next to that material's stock is where they belong. The bulk worklist is preserved as a **“⚠ N need setup”** filter chip on the Stock tab. |
| **Raw Material QR Generator** | **CONVERT TO TAB** (Labels) | Needs party + material + quantity + a range preview + a print sheet + history. That is a workspace, not a drawer — but it does not need its own destination, because you almost always arrive from a material. |
| **Raw Material Receipts** | **CONVERT TO TAB** (Receipts), **RENAMED** in substance | Read-only history. Now states plainly that it shows purchase bills, and gains the physical side — scanned receiving sessions — beside them. |
| **Inventory Categories** | **CONVERT TO TAB** (Setup), **RENAMED** “Raw Material Setup” | `inventory_items` are raw materials only (`RM-` codes). Calling it “Inventory Categories” under Settings hid it from the people who use it. Kept as a Settings deep-link so `settings`-only users do not lose it. |
| **Raw Material Input** | **KEEP AS A SEPARATE PAGE** | A scan station needs the whole screen and sole ownership of the keyboard. Putting it in a tab strip would actively break it. |
| **Raw Material Output** | **KEEP AS A SEPARATE PAGE** | Same. |

### What becomes what

* **Main workspace:** Stock tab. Search, filter, totals, and every per-material action.
* **Master data:** Setup tab (categories, attributes, units, conversions, destinations).
* **Contextual actions:** Adjust stock, cost price, packing, route, movement history, generate
  labels — all on the material, in its drawer or its row.
* **Dedicated operational workflows:** Raw Material Input and Raw Material Output only.
* **History / detail:** Receipts tab (bills + receiving sessions); per-material movement history
  in the drawer; per-QR history stays in QR Management / QR Journey, which already handle
  raw material and are not duplicated here.
* **No longer a destination:** Add Raw Material, Raw Material Packing, Raw Material Stock (as a
  standalone), Raw Material Receipts (as a standalone), Raw Material QR Generator (as a nav
  row — the route survives as a permission-bound deep link), Inventory Categories.

---

## 4. Density decisions

* **Three columns become one.** Material = `display_name` + `item_code`. Category and
  Attributes columns deleted as re-prints; Category survives as a *filter*, which is what it
  was actually being used for.
* The freed width goes to **Packing** and **Route** — the two facts that decide whether a
  material can be scanned at all, and which were previously on a different page.
* Page header, filter bar and KPI strip collapse into one band instead of three stacked blocks.
* Secondary actions (cost price, packing, route, history) leave the row for the drawer.
* The Setup tab's Units & Conversions panel stays collapsed by default; Destinations joins it.
* The Stock table paginates at 50 rows (R20) — it previously rendered every material.

---

## 5. Permissions

Today's access matrix, preserved and made explicit rather than widened:

| Area | Permission | Before | After |
|---|---|---|---|
| Stock / materials / receipts | `stock` | 3 routes | Stock + Receipts tabs |
| Label generation | `raw-material-qr-generator` | 1 route | Labels tab (+ deep-link route kept) |
| Categories / attributes / units | `settings` | 1 route | Setup tab (+ Settings deep-link kept) |
| Input / Output scans | `store-scanning` + session token | unchanged | unchanged |

The workspace route opens for a user holding **any** of those three; the tab strip then shows
only the tabs they hold. A `raw-material-qr-generator`-only user sees exactly one tab — which is
exactly the one page they could open before.

**One deliberate change, flagged for the owner.** `raw-material-packing` is absent from
`routePermission`, so today *any signed-in user* can open it and change what a packet is worth —
and the IPC handlers behind it (`setRawMaterialMovementConfig`, `setRawMaterialHops`,
`createWorkSection`) have no permission check either. Packing directly determines the quantity
every scan adds to stock. Folding it into the `stock`-gated workspace closes that. The visible
effect: a store operator holding only `store-scanning` can no longer edit packing, and the
“Packing” shortcut on the two scan stations is hidden for them rather than leading to a dead
end. **If packing should stay open to store operators, adding `store-scanning` to the
workspace's permission list is a one-line revert.**

---

## 6. Additions

Only two, both filling a gap the schema already anticipated:

1. **Per-material movement history** — a read-only query over `inventory_stock_events`
   (`listInventoryStockEvents`), shown in the material drawer. This ledger has been written
   since day one and never read. It is the only place the three stock writers can be seen
   together.
2. **Receiving-session history** — surfaces the already-implemented, already-unused
   `listRawMaterialReceivingSessions` in the Receipts tab, with the existing printed receipt
   re-offered. The receipt HTML builder moves out of `RawMaterialInputPage` into the feature
   folder so both use one implementation.

No new stock calculation, no second QR registry, no new write path.

---

## 7. Known limits

* **Attributes are immutable after creation, by design** — an item's identity is
  `signature_hash` over its attribute values, and changing one would silently become a different
  material. So “edit raw material” means cost price, packing and route. The new UI does not
  invent an attribute editor.
* **Raw-material stock has no location** (`docs/21`, G2). “In store” is the whole of it.
* The Setup tab's attribute library is still derived from categories rather than stored
  globally — unchanged behaviour, carried over as-is.

---

## 8. Capability checklist (post-implementation)

Every capability the eight pages had, and where it now lives.

| Capability | Where it lives now | How the operator gets to it |
|---|---|---|
| Add raw material | Stock tab → **+ New Material** modal | Inventory ▸ Raw Material |
| Category for a new material | Same modal, first field | — |
| Unit for a new material (+ quick-add unit) | Same modal, `+` beside the unit | — |
| Opening stock / cost price at creation | Same modal | — |
| Dynamic attribute fields + preview name | Same modal | — |
| Quick-add a dropdown option while creating | Same modal, `+` beside the attribute | — |
| Search / filter materials | Stock tab toolbar | default tab |
| Filter by category and by attribute | Stock tab toolbar (attribute filters appear with a category) | — |
| Stock quantity and unit per material | Stock tab, **In store** column | — |
| Per-unit totals and unit-equivalent total | Stock tab KPI strip + "Show total as" | — |
| Adjust stock | Material drawer → **Apply correction** | Open a row |
| Edit cost price | Material drawer → cost price field | Open a row |
| View attributes of a material | Material drawer → "What tells it apart" | Open a row |
| **Movement history per material (new)** | Material drawer → "Movement history" | Open a row |
| Set packing (what one packet holds) | Material drawer → "Packing & route" | Open a row |
| Set the route out of the store (hops) | Material drawer → "Packing & route" | Open a row |
| Find materials that cannot be scanned yet | Stock tab → **⚠ N need setup** chip | one click |
| Add a destination (work section) | Setup tab → Destinations | Inventory ▸ Raw Material ▸ Setup |
| Generate QR labels | Labels tab | tab, or the drawer's "Generate labels for this material" |
| Reprint a past batch / "use again" | Labels tab → Recent generations | — |
| Purchase-bill history by supplier and date | Receipts tab | — |
| Per-material purchase totals | Receipts tab → material chips | — |
| **Receiving-session history + reprint (new)** | Receipts tab → Deliveries received | — |
| Create a purchase bill | Receipts tab → **+ New purchase bill** (Billing screen) | one click |
| Categories: create, rename | Setup tab → Categories | — |
| Attributes: create, assign, edit, remove, options | Setup tab → attributes + library | — |
| Attribute flags (required / searchable) | Setup tab → attribute create/edit | — |
| Units and unit conversions | Setup tab → Units & conversions | — |
| Receive raw material by scan | **Raw Material Input** (unchanged page) | Store ▸ Raw Material Input |
| Issue raw material by scan | **Raw Material Output** (unchanged page) | Store ▸ Raw Material Output |
| Printed receiving receipt / issue slip | Unchanged, on those pages; receipts also reprintable from the Receipts tab | — |
| QR validation, QR history, QR journey | Unchanged — QR Management and QR Journey already handle raw material | Setup ▸ QR Management / QR Journey |

Nothing was dropped. Two things were added, both listed in §6.

## 9. What was built

**New** — `src/renderer/features/rawMaterial/`: `RawMaterialWorkspace`, `StockTab`, `LabelsTab`,
`ReceiptsTab`, `SetupTab`, `MaterialDrawer`, `PackingEditor`, `NewMaterialModal`, `AddUnitModal`,
`AttributeField`, `AttributeLibrary`, `CategoryAttributes`, `UnitsPanel`, `DestinationsPanel`,
`Modal`, `useRawMaterialLookups`, `rawMaterial.ts`, `receivingReceipt.ts`, plus
`components/shared/TabStrip`.

**Deleted** — `RawMaterialMasterPage`, `RawMaterialStockPage`, `RawMaterialLedgerPage`,
`RawMaterialQrGeneratorPage`, `RawMaterialPackingPage`, `InventoryCategoriesPage`, and the CSS
rules that only those pages used.

**Data layer** — `listInventoryStockEvents` (read-only) in `packages/data`, its IPC handler
(gated on `stock`), preload binding and renderer type.

**Duplication removed** — one categories/units loader for the whole workspace instead of four;
one Add Unit dialog instead of two; one attribute field renderer for create and filter instead
of two; one quantity formatter instead of two; one party picker (`SearchableCombobox`) instead
of a bespoke copy; one dialog shell instead of six hand-rolled ones; one printed receiving
receipt instead of one per caller.

**Fixed while verifying in the running app** — the workspace reset to the Stock tab whenever
App re-rendered (a fresh `permissions` array identity re-ran the deep-link effect). Covered by
a regression test.

---

## 10. Stock corrections need approval (added 2026-09-28)

Raw material stock moves by itself: a Raw Material Input scan adds one packet, an Output scan
takes one away. A manual correction is therefore never a movement — it is somebody saying the
system is wrong about the shelf. Until now anyone holding `stock` could apply one silently,
with an optional note.

**Now:** a correction carries a required reason and goes to the administrator. Approving it is
what applies it.

| | Storekeeper (`stock`) | Administrator |
|---|---|---|
| Button in the drawer | **Send for approval** | **Apply correction** |
| Effect | `stock_correction_requests` row, status PENDING. No stock moves. | Applied at once — they are the approver — and recorded as an already-approved request. |
| Who is told | The administrator gets a bell notice that opens the material | — |
| Outcome | The requester gets a bell notice, approved or declined (declining says why) | — |

### How it is kept honest

* **The approval is the application.** `reviewStockCorrectionRequest` moves the status and
  calls `applyInventoryStockChange` in **one transaction**, so an approved request without a
  stock event — or the reverse — cannot exist. The status move is guarded
  (`WHERE status = 'PENDING'`), so two administrators deciding at once cannot both apply it.
* **One stock calculation, still.** `adjustInventoryStock` was split into a transaction-free
  `applyInventoryStockChange` plus a wrapper that opens the transaction. Both paths — an
  administrator's direct correction and an approved request — go through that one function.
  Nothing recalculates a balance.
* **One correction open per material**, enforced by a partial unique index as well as by a
  checked message, so two people cannot correct the same count from two different physical
  checks against a balance the other has already moved.
* **The ledger points back at the decision.** The stock event's note carries the reason and the
  request code (`SCR-000001`), so the movement history explains itself.
* **The boundary enforces it, not the button.** `IPC.adjustInventoryStock` now requires ADMIN;
  a non-administrator calling it directly is refused. Hiding a button is not authorisation.

### Not covered

Opening stock entered when a material is *created* still applies directly under `stock`. That
is part of defining a new material rather than correcting a count, so it was left alone —
say if it should also be reviewed.

---

## 11. Export and import (added 2026-09-28)

### What already existed

Nothing, in the sense of infrastructure. Five screens — Current Stock, Production History,
Customer Ledger, Supplier Ledger, Discount Policy — each wrote their own quoted CSV rows,
their own `Blob` and their own `<a download>`. None wrote a byte-order mark, so a name in
Urdu opened as mojibake in Excel on Windows. Every "PDF export" in the ERP is
`openPrintDocument(html)` — the print window, with Save as PDF. There is no spreadsheet
library, no PDF library and no import of any kind anywhere.

So the first move was to make the thing that was supposed to be reused: `utils/exportFile.ts`
(one CSV writer, BOM included) and `utils/reportDocument.ts` (one printable report on the
letterhead). **All five existing call sites were migrated onto it** — otherwise adding Raw
Material exports would have made a sixth copy, which is exactly what the brief forbids.

**"Excel export" means a UTF-8 CSV**, as it already did everywhere else in this ERP. Excel
opens it directly. Adding SheetJS or ExcelJS to write a flat table would be a large
dependency for no gain (R22). If true `.xlsx` is ever wanted — several sheets, column widths,
formulas — that is a deliberate dependency decision, and it is flagged below rather than
slipped in behind a file extension.

### The audit

| Raw Material area | Excel out | PDF out | Excel in | PDF in | Why |
|---|---|---|---|---|---|
| **Stock tab list** (materials + stock) | **Yes** | **Yes** | **Yes** | No | The analysis dataset *and* the master. Excel for review, filtering and migration; PDF because a stock count is something people carry round the store; import because bulk setup is the one genuine bulk job. |
| **Material drawer — movement history** | **Yes** | No | **Never** | No | The ledger behind one material's balance: the thing you export to reconcile a count. No PDF because we cannot show an opening balance (§10 limits), and a "statement" that cannot would mislead. Never importable — these are records of scans that happened. |
| **Receipts — purchase bills** | **Yes** (one row per *line*) | No | No | No | Reconciliation data, so Excel. No PDF: a printable purchase summary is the **Supplier Ledger**, which already exists in Billing; a second one here would be a second reporting system for the same facts. Bills are entered in Billing, not imported. |
| **Receipts — deliveries received** | No | Already has one | No | No | Each delivery's document is the **printed receiving receipt**, which already exists and is one click from the row. The material-level view of what arrived is the movement history. A third representation would be duplication. |
| **Labels tab — batch register** | **Yes** | **No** | No | No | Audit: who registered which range, for whom, when. No PDF because **label sheets already print** through `openLabelPrintWindow`, and a generic PDF table would be strictly worse than the sheet that exists. The identity range plus the count *is* the list of codes (serials are consecutive), so there is no separate "export the identities" action to keep in step. |
| **Setup — categories & attributes** | **Yes** | No | **No** | No | A reference copy of the attribute model, for review or migration prep. Nobody prints an attribute model. **Not importable**: `field_key` feeds the signature that gives every material its identity, the volume is a handful of rows, and the Setup tab does it in a few clicks — high structural risk, no time saved. |
| **Packing & route** | Covered by the Stock export | Covered by the Stock report | No | No | Already two columns of the materials sheet. A separate packing export would print the same facts twice. |
| **Stock corrections** | No | No | No | No | Brand new, tiny volume, and every *approved* correction is already in the movement-history export with its reason and request code. Declined ones changed nothing. Revisit when there is a year of them. |
| **Raw Material Input / Output** | No | Already have theirs | **Never** | No | Full-screen scanners. Each already prints its receiving receipt / issue slip. Putting a download in a keyboard-focused scanner would be wrong, and importing scans is importing events that never happened. |
| **Units, conversions, destinations** | No | No | No | No | Three to ten rows each, edited in place on the Setup tab. |

### Why no PDF import, anywhere

PDF is a page-description format. Reading structured master data out of one means OCR or
layout heuristics, and both produce values that *look* right — a `0` read as `O`, a `7/10`
read as a date — with no way for the importer to tell. A raw material's attributes feed the
signature hash that IS its identity, so a silently misread cell does not create a bad row, it
creates a **different material** that then accumulates stock and labels. There is no Raw
Material workflow that arrives as a PDF and cannot arrive as a spreadsheet. Excel is the
structured import format; PDF is an output.

### Where the actions live

Six entry points in the whole module, none of them a permanent toolbar button except where
the screen already had a natural home for it:

| Where | What |
|---|---|
| Stock toolbar → **Export / Import ▾** | Materials & stock (Excel) · Stock report (PDF) · Import materials… |
| Material drawer → Movement history heading | Export (Excel) |
| Receipts → Purchase bills heading | Export bills (Excel) |
| Labels → Recent generations heading | Export batches (Excel) |
| Setup → Categories & attributes heading | Export setup (Excel) |

Three rare actions share one drop-down rather than taking three toolbar slots on the screen
the operator uses every hour. The other four sit in the heading of the table they export, one
small button each, where a person looking at that table would reach for them.

### Filtered or everything?

**Exactly what is on screen.** The Stock export and the Stock report both take the rows the
filters left, the menu item says how many (`Materials & stock (Excel) — 42`), and the exported
file and the printed page both list the filters they were taken under. An export that quietly
included more than the operator had narrowed down would be the one thing they could not check.

### The import, in detail

Raw Material Master only — bulk creation of materials.

* **The template is generated for a chosen category.** Attributes are per-category: RUBBER
  UPPER wants ARTICLE / COLOR / SIZE, BUCKLE does not. One fixed template could only ever fit
  one category. The downloaded file carries the exact headings, which are required, and what
  goes in each — including the saved dropdown options, so nobody has to guess that COLOR
  means RED / BLACK / BROWN.
* **Column names are shared with the export.** A materials export can be edited and sent
  straight back; the parser skips our own title and filter lines to find the heading row.
* **Nothing is written on upload.** The file is parsed, validated and shown as a preview with
  a verdict per row. The same validation then runs again for the real thing, so the preview
  cannot promise something the import refuses.
* **Validation:** required columns present (a missing one refuses the whole file, once,
  rather than rejecting every row for the same reason); required attributes per row; numbers
  that are numbers; units that exist; opening stock only with a unit; packing only with a
  packing unit.
* **Duplicates, both kinds:** the same material twice in one file (reported with the row it
  repeats), and a material the database already holds (reported with its item code and left
  **untouched** — an existing material carries stock, labels and history a spreadsheet knows
  nothing about).
* **Transaction safety:** every valid row is created inside **one** transaction. `createInventoryItem`
  was split into `insertInventoryItem` (no transaction) plus a wrapper, so the import and the
  single-material form run the same insert, the same rules and the same audit write. A file
  that fails half way through leaves no materials behind — there is a test that kills the
  second row and asserts the first is gone.
* **Nothing is silent.** Rejected rows are named with every reason, in the preview *and* in
  the summary. The confirm button says exactly what it will do: "Create 198 materials".
* **Permissions and audit unchanged:** `stock`, the same as creating one material by hand, and
  every imported material writes the same `inventory_item_audit` CREATE row with the operator's
  name.
* **The route is deliberately not imported.** Destinations are a per-material decision with
  real sections behind them; the "needs setup" chip on the Stock tab shows what is still
  missing after an import.

### Open question

Whether "Excel export" should become true `.xlsx` rather than the UTF-8 CSV the whole ERP
uses today. CSV needs no dependency and imports back; `.xlsx` would give column widths, number
formats and several sheets in one file, at the cost of a sizeable library. Say the word if the
office wants it.

---

## 12. Every material has its own pack (added 2026-09-29)

### What was wrong

A Stock row read:

```
DANA — EVA — BLACK      0 DOZEN     25 KILOGRAM     MACHINE
```

Packing recorded **how much** was on a label but never **what the thing is called**, so every
screen had to say "packet" and the row above says, to anyone reading it, *"one dozen is
twenty-five kilogram"*. It is not. DANA comes in a **BAG**, and one bag is 25 kg. Rubber
topping comes in a PACKET of 2 dozen. Ragzine comes on a ROLL. The container is a property of
the material, exactly as its packing quantity is, and without it the two figures on a row have
nothing binding them together.

### The pack now has a name

`inventory_items.pack_name` — the store's own word: BAG, PACKET, ROLL, BUNDLE, TIN, DRUM, BOX,
CARTON, SHEET. Offered as suggestions, not a fixed list, because the next material will come in
something nobody has thought of. Unnamed materials fall back to the neutral **PACK**, so
nothing that already worked changed meaning.

**Not snapshotted onto the QR**, unlike `packing_quantity`. The quantity is snapshotted so that
correcting a material's packing never changes what labels already on the shelf are worth; the
name is only what the store *calls* the thing, so correcting BAG to SACK should read as SACK
everywhere at once, including on labels already printed.

### Where it shows, and where it does not

| Screen | Before | Now |
|---|---|---|
| Packing editor (drawer) | "One packet holds [2] [DOZ]" | **One [BAG] holds [25] [KILOGRAM]**, read back as a sentence: *One BAG = 25 KILOGRAM* |
| Stock row, "One pack" | `25 KILOGRAM` | **BAG** / `25 KILOGRAM` underneath |
| Raw Material Input | "2 DOZ added to stock" | "**1 BAG (25 KILOGRAM)** added to stock" |
| Raw Material Output | "2 DOZ sent to PACKING" | "**1 BAG (25 KILOGRAM)** sent to MACHINE" |
| Materials export / import template | "One packet holds" | **Pack name** + "One pack holds" |
| QR label sheet | — | unchanged; the sheet is printed per label and the name is read live |

The editor is laid out as a sentence rather than three labelled boxes because that is how the
store says it. The sentence is read back under the fields, so what was typed is checked as a
statement, not as three separate values.

### The trap it uncovered

DANA was not only mis-worded, it was **unusable**: stocked in DOZEN, packed in KILOGRAM, with
no conversion between the two. `applyRawMaterialStockChange` refuses a quantity it cannot
convert, so **every scan of that material would have failed at the scanner** — and nothing on
screen said so, because the readiness check only asked whether packing and a route existed.

So `packingConvertsToStock` now comes back with the configuration (same unit, or a conversion
exists either way round), and:

* `isReadyForStore` requires it, so the material joins the **"⚠ N need setup"** worklist;
* the Stock row shows **⚠ Cannot reach DOZEN** under the pack;
* the drawer says it in full: *"Stock is counted in DOZEN, but a pack is measured in KILOGRAM
  and there is no conversion between them. Every scan of this material would be refused. Add
  the conversion under Setup → Units, or measure the pack in DOZEN."*

A material with no packing yet, or no stock unit yet, is not flagged — there is nothing to
reconcile, and the first movement establishes the balance in the pack's own unit.

### Tests

`packages/data/src/rawMaterial.test.ts` gains two: the name is stored the way the store writes
it and is left alone by a packing save that does not mention it (an empty string clears it);
and the DOZEN/KILOGRAM trap is reported, clears once the conversion is added, and never fires
for a material packed in the unit it is stocked in.

---

## 13. Categories gained sub-categories (added 2026-09-29)

### Why a sub-category is not just another attribute

An **attribute** tells two materials of the *same kind* apart — SK6 RED from SK6 BLACK. A
**sub-category** says they are different *kinds* that happen to live together: DANA comes as
EVA and as PVC, RAGZINE as PLAIN and as PRINTED. Forcing that into an attribute would mean
every kind of DANA carried every other kind's questions.

### The model

`inventory_categories.parent_id` — a category may sit under another one, **exactly two levels
deep**. A sub-category *is* a category: its own attributes, its own items, its own code.

* **Attributes are inherited.** A sub-category asks for everything its parent asks for, plus
  its own. `effectiveCategoryFields` is the one definition of "the fields of a category" —
  item creation, the identity signature, the display name and every screen read it, so they
  cannot drift apart. An attribute the parent already defines **cannot be redefined**
  underneath it, or a material would have two answers to the same question.
* **Identity is scoped to the leaf.** The signature hashes the category id with the attribute
  values, and that id is the *sub-category's* — so EVA grade A and PVC grade A are two
  materials, not a collision. Within one sub-category the duplicate rule is unchanged.
* **A material goes in a leaf.** A category with sub-categories is a grouping; creating a
  material directly in one is refused with *"DANA has sub-categories — choose the one this
  material belongs to."*
* **Names are unique among siblings.** PLAIN under RAGZINE and PLAIN under DANA are different
  things and the store calls them both PLAIN. This needed a **table rebuild**: `name` and
  `category_code` carried table-level `UNIQUE` constraints, which SQLite cannot drop. Replaced
  by unique indexes on `(COALESCE(parent_id,''), UPPER(name))` and the same for the code.
* **Re-parenting is not offered.** An item's stored display name carries its category path, so
  moving a sub-category would leave every material it holds describing a place it no longer is.
* **Display name carries the path**: `DANA — EVA — A40`. A top-level category is unchanged:
  `BUCKLE — 20MM`.

### Where the filters went

| Screen | What it does |
|---|---|
| **Stock toolbar** | **Category** lists only top-level ones. Choosing one reveals a **Sub-category** select — "All of DANA", then EVA, PVC. |
| Scope of a filter | A parent means **everything under it**; a sub-category means just that one. Resolved in the data layer (`listInventoryItems`), so `queryInventoryStock`'s totals follow the same scope through the same filter. |
| Attribute filters | Follow whichever level is selected. A sub-category's fields already include the inherited ones, so narrowing never loses a filter. |
| Exported file / printed report | Carry the filters they were taken under, sub-category included. |
| **New Material** | Category → Sub-category, **required** when the category has any. Attribute fields appear for the leaf, inherited ones included. The preview name shows the path. |
| **Setup tab** | The sidebar is a two-level tree. Each top-level category has **+ Sub**, the only place a sub-category can be born — it has to know what it is a kind of. |
| Attributes panel | Heading reads `DANA — EVA`. An inherited attribute is tagged **FROM DANA** and has no Edit or Remove: it is changed where it is defined, and every sub-category follows. |
| **Materials export** | Gains a **Sub-category** column beside Category. |
| **Import** | The category picker includes sub-categories; the template's columns are the leaf's *effective* attributes, and a dropdown's saved options are found whether defined on the category or inherited. |

### A trap worth recording

The migration runner splits a `.sql` file on `;`. A semicolon **inside a comment** therefore
cuts a statement in half — and in a rebuild migration that meant a `DROP TABLE` running
without its replacement having been created. Caught before it shipped, but the rule is now:
**no semicolons in migration comments.**

### Tests

`packages/data/src/subCategories.test.ts` — nine cases: inheritance and the `inherited_from`
flag, a sibling not seeing another sibling's attributes, redefining an inherited key, the
two-level limit, sibling-scoped naming, the leaf rule, EVA grade A vs PVC grade A, parent-scope
vs leaf-scope filtering (items *and* stock totals), the row's `top_category_name` /
`sub_category_name`, and a category with no children behaving exactly as before.

---

## 14. Stock is counted in packs (added 2026-09-29)

### The ask

> "In store 3 BAGS | One pack BAG 25 KG | Converted 75 KG"

A storekeeper walking the shelf counts **bags**, not kilograms. The balance was being shown
only in the unit it is measured in, so the one number on the row was the one nobody counts.

### The row now

| Material | In store | One pack | Total qty | Route out |
|---|---|---|---|---|
| DANA — EVA — A40 | **3 BAGS** | **BAG** / 25 KILOGRAM | **75** KILOGRAM | MACHINE |
| RUBBER UPPER — SK6 — RED | **74 PACKETS** | **PACKET** / 2 DOZ | **148** DOZ | PACKING |
| RAGZINE — RED *(no packing yet)* | **0** MTR | ⚠ Not set | 0 MTR | ⚠ No route |

The drawer leads the same way: **3 BAGS**, with *"that is 75 KILOGRAM"* underneath.

### Where the division happens, and why it is not a screen's job

`packs = balance ÷ pack size` looks like something a screen could do with the two numbers it
already has. It is not, because **a pack is measured in its own unit**: a PACKET of *2 DOZEN*
on a material stocked in *PIECE* is **24 pieces**, so dividing the balance by 2 would be wrong
by a factor of twelve.

So the data layer returns `packSizeInStockUnit` — one pack already converted into the unit the
balance is held in, using the conversion table, which is where conversions live. Screens
divide; they never convert. One helper, `packsOnHand`, is the only place that division
happens, and the table, the drawer, the spreadsheet and the printed report all call it.

Nothing about stock storage changed. `inventory_stock_balances` is still the single source of
truth, still held in the measured unit, still the figure every scan and correction writes.
Packs are a way of reading it.

### When there is no honest pack count

`packsOnHand` returns null — and the screen falls back to the measured balance, exactly as
before — when the material has no packing, or when a pack could never reach its balance (the
DOZEN/KILOGRAM trap from §12). A row is never given an invented pack count.

Totals in the KPI strip stay in measured units: bags and rolls and boxes cannot be added up.

### Elsewhere

* **Materials export** gains **Packs in store** beside the existing **In store**, which keeps
  its meaning (the measured figure) so nothing already saved changes.
* **Stock report (PDF)** leads with packs and carries **Total qty** beside it.
* Pack names are pluralised for display only (BAG → BAGS, BOX → BOXES); the name is stored
  singular, and this is the seam Urdu replaces later.

### Tests

`rawMaterial.test.ts` covers the sizing: same unit (25 KG bag → 25), a cross-unit pack
(2 DOZEN box on a PIECE-stocked material → 24, not 2), no conversion (null), and no packing
(null). `rawMaterialExports.test.ts` asserts the report leads with `74 PACKETS` and carries
`148 DZN`, and that an unpacked material shows `0 MTR` instead of a made-up pack count.

---

## 15. A sub-category's setup is inherited (added 2026-09-29)

### The request

> "If I make a new item, the unit and hops would remain same. So make it automatically inherit
> for same sub-category. DANA — EVA — BLACK, DANA — EVA — RED, DANA — EVA — BLUE all has same
> unit and same hops. The *what one pack is, and where it goes* thing would also be same for
> same sub-category."

### What it means

A sub-category is not a folder. **DANA — EVA — BLACK, RED and BLUE are one material in three
colours**: the same granule, arriving in the same 25 kg bag, going to the same machine. The
colour is the only thing that differs, which is exactly why it is an attribute and the rest is
not.

So configuring the pack and the route once per colour was not thoroughness — it was three
chances to disagree with itself. A sub-category should answer the question once.

### Derived, not stored

There is no "category default" column, and deliberately so. A stored default would be a
**second place** where a pack is written down, and the day the bag changes from 25 kg to 50 kg
the default and the materials would begin to disagree — with nothing on screen saying which of
them the scanner believes.

Instead the answer is **read back from the materials themselves**:

```text
rawMaterialSetupTemplate(categoryId)
  → the ACTIVE material in this category, configured most recently,
    that actually has a pack
```

A sub-category therefore "remembers" the last material set up in it, because that material *is*
the memory. Nothing can drift, because there is only ever one copy of the fact.

Null is a real answer: nothing in this sub-category has a pack yet. The first material is
configured by hand, and every one after it follows.

### What a new material inherits

| Inherited | Why |
| --- | --- |
| Stock unit | Prefilled into the ordinary select, and can be changed — it is the one part an operator may legitimately differ on |
| Pack name, pack quantity, pack unit | Physical facts about the container, identical across colours |
| The route, in order | The same granule goes to the same machine whatever colour it is |

It is **said out loud before saving** — *"Will follow DANA — EVA — BLACK · One BAG = 25
KILOGRAM · MACHINE"* — because inheriting silently would mean an operator finds out what a pack
is when the first label prints. When there is nothing to inherit, the form says that too, and
explains that this material's setup is what the next one will follow.

Opening stock, cost and the identity attributes are **not** inherited. They are facts about
this material, not about its kind.

### Applied inside the create transaction

`insertInventoryItem` now takes the pack and the route and writes them itself, inside the
transaction that creates the material. A material is therefore never created *and then*
configured: either it exists with its pack and route, or it does not exist.

This needed the same split already used for stock changes and hops — a transaction-free core
plus a wrapper that opens the transaction:

```text
writeRawMaterialMovementConfig   ← no transaction; callers own it
setRawMaterialMovementConfig     ← wrapper, for the single-material save
```

The old method opened a nested transaction when it seeded a route, which is a crash waiting
inside any caller that already had one. Splitting it also made the single save atomic, which it
had not been. The import was moved onto the same create path at the same time, so the pack now
reaches an imported material through exactly one code path.

The route is written **before** the pack, so a destination that no longer exists is reported by
name rather than surfacing as a foreign key failure on `default_section_id`.

### Changing the whole sub-category at once

The packing editor gained one tick: **"Give the other 2 materials in DANA — EVA this same pack
and route"**. It counts what it would touch, and it is off by default.

`applyRawMaterialSetupToCategory` writes every active material in the category in **one
transaction** — a bag changing from 25 kg to 50 kg is one fact about DANA — EVA, not ten facts
about ten colours, and a half-applied change is exactly the state that makes a store distrust
the system. A failure rolls the whole sub-category back.

**The stock unit is deliberately not part of it.** Changing what a material is counted in while
it holds stock would reinterpret the balance already on the shelf — 100 becomes 100 of something
else without a single scan. That stays a per-material decision.

The bulk action requires the `stock` permission at the IPC boundary. The tick only appears
inside the Stock tab, and a hidden control is not authorisation.

### Tests

`packages/data/src/setupInheritance.test.ts` (9): no template for an empty sub-category or one
with no pack yet; the template is the most recent setup and follows a later correction; a
sibling sub-category is unaffected; creation applies the pack and route it was given and leaves
an unconfigured material alone; the bulk apply touches every material in the category and only
that category; it does not change what a material is counted in; and a bad destination rolls the
whole sub-category back.

`setupInheritance.test.tsx` (9) covers the screens: the "will follow" line names its source, the
unit prefills, the create payload carries the pack and route, a sub-category with nothing to
inherit says so and no pack is invented for it, the tick counts the other materials, ticking it
routes the save through the single bulk call instead of the per-material writers, leaving it
alone touches only this material, and it stays available for pushing an unchanged setup outwards.
