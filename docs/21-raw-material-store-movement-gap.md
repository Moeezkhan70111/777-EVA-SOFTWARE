# Store Move IN / OUT for Raw Materials — Architecture Gap

**Date:** 2026-09-26
**Status:** RESOLVED 2026-09-26. The owner answered D1 and D2 (see §4). Built on migrations
`037_raw_material_packing_and_sections` and `038_raw_material_receiving_sessions`.

**Superseded on one point:** the original brief asked for the carton Store Move In / Move Out
screens to serve raw material too. On seeing it work the owner reversed that — a carton and a
packet are now separate identities with separate scanners. Receiving lives on its own
**Raw Material Input** page (supplier session, supplier-checked scans, printable receipt);
the carton screens recognise a packet label and turn it away with a pointer to it. Everything
in §3 about why the two stock models differ still holds, and is why the separation is the
better fit. D3 was settled in favour of a separate event table read through one journey API,
so QR Management and QR Journey remain one screen for both — see §3 G3.

**Still open:** issuing raw material out of the store (the D2 destination model) has no screen
since the separation. The data layer and destinations still support it.
**Asked for:** extend the existing Store Move IN / Store Move OUT pages so they move raw materials as well as finished cartons, through one QR/journey architecture, with no new pages.
**Companion:** `migrations/sqlite/036_raw_material_qr.up.sql`, `packages/application/src/storeEntryScanUseCase.ts`, `packages/data/src/database/rawMaterials.ts`.

---

## 1. Why this stopped

The requirement itself says: if a raw-material QR does not carry enough information to move stock safely, stop and report rather than invent a quantity rule.

That condition is met, and it is not a single missing column. **Finished goods and raw materials are two unrelated stock models**, and Store Move IN/OUT is built entirely on the finished-goods one.

Reading a raw-material QR and identifying the material is easy. Moving stock with it is not yet possible without inventing business rules.

---

## 2. The two models, side by side

| | Finished cartons | Raw materials |
|---|---|---|
| Identity format | `SK6_RED_7/10_000001` | `RMQR_PTY000002_RM000001_000001` |
| Registry at generation | `qr_codes` | `raw_material_qrs` |
| Live unit record | `qr_master` (status + location) | **none** |
| Movement history | `production_events` | **none** |
| Stock held in | `stock_projection_by_variant` (count) and `stock_projection_by_location` (count per FACTORY / WAREHOUSE / GATE) | `inventory_stock_balances` — one `REAL` quantity per item, in a unit |
| Location tracked | Yes | **No** |
| What one QR is worth | Exactly one carton | **Not recorded** |
| Keyed by | `product_variants.id` | `inventory_items.id` |

Everything the Store pages rely on sits in the left column.

---

## 3. The gaps, with evidence

### G1 — A raw-material QR carries no quantity and no unit

`raw_material_qrs` holds `id, batch_id, party_id, item_id, sequence, status, created_at, updated_at`
(`migrations/sqlite/036_raw_material_qr.up.sql`). There is no physical amount anywhere on it.

The "Quantity" field on the QR Generator is **how many labels to print**, not what each label represents
(`RawMaterialQrGeneratorPage.tsx`, `generateRawMaterialQrBatch`).

Raw-material stock is `inventory_stock_balances.quantity_on_hand REAL` in a `unit_id`
(`local-schema.sql`). So Store Move IN has no answer to *"add how much?"*. If an item is stocked in
METER, one label could be a 50 m roll or a 100 m roll; nothing distinguishes them.
`inventory_items.default_unit_id` gives the unit but is nullable and says nothing about amount.

Finished goods avoid this entirely: `buildQrId` issues one serial per physical carton, so one QR is
always exactly one carton.

**This is the blocking gap.**

### G2 — Raw-material stock has no location

Finished-goods Store Move IN/OUT is a **location move, not a quantity change**. The unit already
exists in stock; the scan shifts it between FACTORY, WAREHOUSE and GATE rows of
`stock_projection_by_location`. (Current Stock is the WAREHOUSE figure — see the Current Stock
change of 2026-09-22.)

`inventory_stock_balances` is a single global row per item with no location column. There is nothing
to move a raw material *between*, so "In Store" cannot currently be expressed for one.

### G3 — The QR journey is bound to product variants

- `qr_master.product_variant_id` — `NOT NULL`, FK to `product_variants`
- `production_events.product_variant_id` — `NOT NULL`, FK to `product_variants`, plus `article_snapshot`, `color_snapshot`, `size_snapshot` all `NOT NULL`
- `getQrJourney` reads `qr_codes` and `qr_master JOIN product_variants` (`database/qrCodes.ts`)

A raw material has no variant and no article/colour/size. The requirement that raw-material movements
appear in the *same* journey therefore needs a schema change, not just code.

### G4 — Raw-material QRs have no lifecycle

`raw_material_qrs.status` is written once as `'GENERATED'` and never read again — there is no
lookup-by-QR-id anywhere in the codebase. No current status, no current location. Duplicate-move
protection and disabled/void handling have nothing to check against.

### G5 — The raw-material lifecycle is undefined as a business process

This matters more than the schema.

For a carton, Store OUT means *"to the gate, heading to a customer"*. For a rubber upper it most
likely means *"issued to the production floor"* — a different event with different accounting.

A raw-material QR is also generated at **supplier receipt**, so Store IN would be its first physical
event, with no prior production stage. The existing ladder —
`PRODUCED → WAREHOUSE → TO_GATE → DISPATCHED` — does not describe raw material. Reusing those status
names would make the shared journey misleading rather than genuinely unified.

---

## 4. Decisions needed

### D1 — What does one raw-material QR label represent? *(blocking)* — ANSWERED: option A

> "EVERY LABEL OF RAW MATERIAL HAS DIFFERENT UNIT… RUBBER UPPER 7/10 — ONE PACKET CONSIST OF
> 2 DOZEN. LABEL WILL BE ON PACKET. BUT 4/6 HAS 3 DOZEN IN ONE PACKET."

One label is one PACKET. Packing is configured per material (7/10 and 4/6 are already separate
`inventory_items` rows) and snapshotted onto each label as it is printed.


| Option | Consequence |
|---|---|
| **A. Fixed amount captured at generation** | Add `quantity_per_qr` + `unit_id` to the batch and QR; the Generator gains one field ("each label = ___ [unit]"). Store IN/OUT moves exactly that amount. Needs a migration and a decision on the QRs already issued (backfill, or treat as 1). Most faithful for rolls, bags and boxes. |
| **B. One QR = one handling unit, counted as 1** | No generator change, no new field. Only correct where the item's stock unit *is* its handling unit — works for BUCKLE in PIECE, breaks for EVA SHEET in METER. |
| **C. Operator types the amount at Move IN** | Handles variable quantities (cut lengths, weighed goods) but slows scanning and reintroduces the manual entry the QR was meant to remove. |

A and C can coexist: a default from the label, overridable per scan.

### D2 — What does Store Move OUT mean for a raw material? — ANSWERED: per-material destination

> "EACH RAW MATERIAL GOES AT DIFFERENT PLACES. LIKE RUBBER UPPER GOES TO PACKING. BUT RAGZINE
> GOES TO UPPER MAKER."

Move Out issues a packet to the section configured on the material, so the operator still only
scans. Statuses are GENERATED → IN_STORE → ISSUED.


| Option | Consequence |
|---|---|
| **A. Issued to production** | Maps onto the existing `CONSUME` / `TRANSFER_OUT` stock events, which the `inventory_stock_events` CHECK already allows. Needs its own status, not `TO_GATE`. |
| **B. Reuse the GATE path** | One status ladder for everything, at the cost of a journey that says a rubber upper is "at the gate" when it went to the shop floor. |
| **C. Both, operator picks** | Most faithful (issued to production vs. returned to supplier), but adds a choice to the scan flow. |

### D3 — How far to unify the journey?

Given G3, recording raw-material movement in the existing journey requires one of:

1. **Widen the existing tables** — make `product_variant_id` nullable, add `inventory_item_id` and a
   kind discriminator, relax the snapshot columns. One journey, one set of queries; touches the most
   heavily used tables in the system.
2. **A shared scannable-unit table** above both — cleaner separation, larger change, every existing
   journey query has to be re-pointed.
3. **Parallel raw-material event log**, presented as one journey in the read layer only — smallest
   schema change, but it is the "separate history system" the requirement rules out.

Option 1 is the smallest change that satisfies the requirement as written.

---

## 5. What is already ready

One piece is genuinely simple and was deliberately **not** built, because a resolver that cannot
finish a movement is placeholder architecture:

Both use cases open with `parseQrCode()` (`storeEntryScanUseCase.ts`, `storeExitScanUseCase.ts`),
which only understands `ARTICLE_COLOR_SIZE_SERIAL` and rejects `RMQR_…` as `INVALID_FORMAT`.
Replacing that single call with a resolver that tries `parseQrCode` and then
`parseRawMaterialQrId` (`packages/domain/src/rawMaterialQr.ts`, already written and tested) is the
clean seam for "the QR decides what the item is" — no inventory-type selector, no second page.

Everything downstream of that seam waits on D1–D3.

---

## 6. Sequence once decided

1. D1 → migration adding quantity/unit to the raw-material QR registry, plus the Generator field.
2. D2 → the raw-material status ladder, expressed in the existing status vocabulary where it
   genuinely fits and new values only where it does not.
3. D3 → schema change for the shared journey.
4. A location dimension for raw-material stock (G2), or an explicit decision that raw material is
   tracked only as in-store/not-in-store.
5. Resolver seam in front of `parseQrCode`, then extend the two use cases behind their existing
   ports rather than adding `processRawMaterialStoreIn`.
6. Extend the existing scan-result card to render either identity.
7. Tests A–L from the requirement.

---

## 7. Files inspected

`StoreScanningPage.tsx`, `StoreMoveOutPage.tsx`, `storeEntryScanUseCase.ts`,
`storeExitScanUseCase.ts`, `database/store.ts`, `database/qrCodes.ts` (`getQrJourney`),
`database/rawMaterialQr.ts`, `database/rawMaterials.ts`, `domain/qr.ts`,
`domain/rawMaterialQr.ts`, `local-schema.sql`, `migrations/sqlite/036_raw_material_qr.up.sql`.

**No files were changed.**
