# Upper Move Out — Phase 3

> Built 2026-10-14. Migration 079. The QR Generator's fourth tab: issue upper packets out of the store
> to a chosen machine, and see the upper stock. Upper returns, reconciliation, cut size and claims are
> later phases.

## Where it is

QR Generator → `[ Carton QR ] [ B-Carton Labels ] [ Receive Production ] [ Upper Move Out ]`, with
`[ Move Out ] [ Stock ]` inside (Move Out first). Machine Program stays its own page (Phase 1.1), so
Upper Move Out is the fourth tab after the two that exist. Offered to users who may open Raw Material
Output (Store Scanning or Raw Material Output permission); the main process checks it on every call.

## What an "upper carton" is in this database

A **raw material packet**: an `RM_…` QR (raw_material_qrs) of a material whose **top-level category is
UPPER** (`RAW_MATERIAL_KIND.UPPER`, `KIND_SQL` — the rule the store already used), received into the
store on Raw Material Input. Its quantity is the packet's packing (e.g. 5 DOZEN) in the material's stock
unit. It is **not** a finished-goods carton QR: those are refused here as `FINISHED_CARTON`.

**Stock source of truth:** `inventory_stock_balances.quantity_on_hand` per material, with
`raw_material_qrs.current_status = IN_STORE` for the packets. No new stock table.

## One issue path

```
scan / typed code + machine → useScanBox (one at a time)
  → erp:issue-upper-to-machine   (STORE_SCANNING or RAW_MATERIAL_OUTPUT)
  → UpperMoveOutUseCase          @erp/application, one BEGIN IMMEDIATE:
       machine exists and ACTIVE?           MACHINE_INELIGIBLE
       packet registered?                   UNKNOWN_QR
       material is an UPPER?                NOT_UPPER
       already ISSUED?                      ALREADY_ISSUED
       → issueRawMaterialPacket (the ONE place any raw material packet leaves the store),
         binding { mode: "MACHINE", machineId }:
           IN_STORE → ISSUED, guarded (WHERE current_status = IN_STORE)   — one issue per packet
           stock debited; refused if it would go below zero              — INSUFFICIENT_STOCK
           STORE_EXIT event with machine_id, actor, the device's issue session
```

Before the transaction: no machine → `MACHINE_REQUIRED`; a carton QR → `FINISHED_CARTON`; anything
else unreadable → `INVALID_QR`. The `MACHINE` binding consumes no machine-program allocation (the
retired programs' reservations are not this screen's to keep). AUTO and PROGRAM bindings are unchanged.

**Session:** the device's existing Raw Material Output issue session (`raw_material_issue_sessions`,
one open per device per day) — reused, not a new kind. Reads never open one.

## Migration 079

`raw_material_qr_events.machine_id` (REFERENCES machines) + index `(machine_id, event_ts_local)`.
Written once with the event, never updated, so changing the selected machine cannot move a past issue.
NULL for every exit that is not Upper Move Out.

## Exactly once, never negative

* Guarded status move: two scans of one packet — however concurrent — produce one ISSUED.
* `applyRawMaterialStockChange` refuses a balance below zero inside the same transaction.
* Status, stock, stock event and STORE_EXIT commit together or roll back together (tested by failing
  the event insert after the status moved and the stock was debited).
* Issues are run one at a time through the use case (see docs/32 on `runInTransaction`).
* A failed call is settled with `erp:find-upper-issue`, never retried blindly.

## Screens

* **Move Out** — machine select (every ACTIVE machine; nothing scans without one), the scan station
  (scanner bursts send themselves; typed codes wait for Enter or the button), Upper Out Details (today,
  this machine, 25 a page), and a Summary that keeps three measures apart: this session to this machine,
  today to this machine, and upper stock in the store. Quantities stay in each material's own unit and
  are never added across units.
* **Stock** — every UPPER material with stock or packets in the store: article, size, colour, category,
  packets in store, available (the balance). Search in the main process. Polled every 10 s.

Both lists use the shared `usePolledRead` (hooks/) — Receive Production moved onto it too — and the
shared `Pager` (components/shared/).

## Not done here (later phases, or owner decisions)

* Old machine-program reservations: Upper Move Out does not consult or consume them, and Stock shows the
  balance, not balance minus reservations. Programs still open from the retired workflow can therefore
  lose uppers they reserved to an Upper Move Out issue.
* "Equivalent dozens": uppers are counted in their own unit (DOZEN in practice); no carton conversion is
  applied, because an upper packet is not a 6-pair carton.
* Upper returns are Phase 4+. A packet that comes back (Raw Material Input) shows "Back in store".
