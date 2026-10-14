# Machine Program — Phase 1 / 1.1: programs from the QR Generator

> Phase 1 built 2026-10-13 (migration 077). Phase 1.1 the same day (migration 078) — read §1.1
> first; it supersedes "What the page was in Phase 1" and its data flow. Store Move In / Move Out,
> machine issue and production tracking are later phases.

## 1.1 One program per machine per day (current)

Owner, 2026-10-13: B-Carton Labels belongs in the QR Generator, both generators ask for the machine
first, machines are set up on the Machine Program page with their two contractors, and every
machine has its own program — "for now one machine, one program per day" (the rule may change).

```
QR Generator                                         Machine Program                  [+ Add Machine]
[ Carton QR ] [ B-Carton Labels ]                    MACHINES
MACHINE  [● MACHINE 1  ASLAM · BABAR] [ MACHINE 2 ]  ┌ MACHINE 1  M-001 ┐ ┌ MACHINE 2  M-002 ┐
( generator form, unchanged )                        │ ASLAM · BABAR    │ │ KHAN · BABAR     │
                                                     PROGRAMS                [‹][13/10/2026][›]
                                                     ┌ MP-000123 MACHINE 1   10 cartons · 5 DZN ┐
                                                     │ Article Size Colour Carton QRs Dozens …  │
```

| | |
|---|---|
| Program | A row in `machine_programs` — the same table, numbering (MP-000NNN) and `(machine_id, program_date)` partial unique index the old workflow used, so MP numbers never collide and Store In/Out can look them up. |
| Opened | By the machine's **first QR run of the business day** (Asia/Karachi), inside that run's own `BEGIN IMMEDIATE` (`cartonProgram.ts openMachineDayProgramInTransaction`). Later runs that day join it. A refused or rolled-back run opens nothing. |
| Contractors | Stamped on the program when it opens (`contractor_name_snapshot`, `packing_contractor_name_snapshot`). Changing a machine's contractor applies from its next program; an open program keeps its pair. |
| Run → program | `qr_batches.machine_program_id` (migration 078). Runs before 1.1 have none and are in no program. |
| Refused | No machine (IPC), unknown or retired machine, or a missing / inactive / non-Contractor machine or packing contractor — before any serial is taken. |
| Counted | Runs of source `QR_GENERATOR` and `B_CARTON` (a B line is its own row, marked B). Not voided codes. Dozens via `formatQuantityInDozens`. |
| Machines | `AddMachineUseCase` (application): name + both contractors in one audited transaction; a name already used is refused, never re-assigned. Changing contractors reuses `AssignMachineContractorUseCase`. Both behind the Machine Program permission. |
| Retiring | `setMachineStatus` now refuses only while a live program **has runs** (holds a reservation). A day program holds carton QRs only, so it never blocks retiring a machine. |
| QR Generator | `QrGeneratorWorkspace`: the machine picker is above both tabs and stays chosen across them; Generate is disabled until a machine is chosen. `b-carton-generator` is now a deep link onto the B tab; its own nav entry is gone. |

## What the page was in Phase 1 (superseded by 1.1)

```
Machine Program
[ Machine Program ] [ B-Carton Labels ]                                   [ Refresh ]
Article   Size   Colour      Carton QRs   Equivalent Dozens   Runs   Last generated
▸ SK6     7/10   BLACKGREY          10              5 DZN       1    13 Oct 2026 10:42
```

* One line per **article size + colour** the QR Generator has registered carton QRs for.
* **Carton QRs** = registered codes of those runs that are not voided. One QR is one carton.
* **Equivalent Dozens** = `formatQuantityInDozens(cartons)` — the one rule in `@erp/domain/units.ts`
  (2 cartons to the dozen). Nothing on the page converts on its own.
* Opening a line lists each QR Generator run behind it (range, count, when, by whom), so merging
  runs into one total never hides which run a carton came from.
* **B-Carton Labels** tab = the existing `BCartonGeneratorPage`, rendered with `embedded` (only its
  page heading is left out). Shown only to users who can open `b-carton-generator` (QR Generator
  permission); the generate IPC re-checks it. The standalone B Carton Labels page and route remain.

## Phase 1 data flow (superseded by 1.1)

```
QR Generator page → generateQrBatch (IPC, QR_GENERATOR permission)
  → qr_batches (source = QR_GENERATOR) + qr_codes, one BEGIN IMMEDIATE transaction
Machine Program page → listCartonProgram / listCartonProgramBatches (IPC, MACHINE_PROGRAM permission)
  → data/database/cartonProgram.ts: SELECT … FROM qr_batches JOIN qr_codes WHERE source = 'QR_GENERATOR'
```

There is **no program table**. The program is derived from the registry on every read, so:

| Risk | Why it cannot happen |
|---|---|
| Refresh / re-render / tab switch adds cartons | Both reads are SELECTs. Nothing is written. |
| A failed or partial generation is counted | The run and its codes commit together or not at all. Counts come from `qr_codes` rows, never from the request. |
| A retried request double-counts | Each successful run is its own persisted run; a refused one leaves nothing. Identities are PRIMARY KEYs. |
| B cartons, old machine-program labels or scan-adopted codes counted | `qr_batches.source` (migration 077) names the writer; only `QR_GENERATOR` is read. |
| Variants merged | Grouped by `article_size_id` + normalised colour; `product_variant_id` is returned with the line. |

## Migration 077 — `qr_batches.source`

`QR_GENERATOR`, `B_CARTON`, `MACHINE_PROGRAM`, `SCAN_ADOPTED`. New runs always carry it:
`reserveQrBatchInTransaction` requires it (the retired workflow's four writers pass
`MACHINE_PROGRAM`), `generateQrBatch` derives it from the grade (the two generator pages), and Live
Production adoption writes `SCAN_ADOPTED`. Existing rows are backfilled most-specific-first —
see the migration's header. No run or code is created, deleted or re-sequenced.

## Retired

* The planning UI in `features/machineProgram` (machines strip, injectors, soles, runs, uppers,
  FIX runs, contractor assignment and pricing dialogs, program print) — deleted; in git history.
* Its 15 IPC channels (`listMachineProgramBoard`, `getMachineProgramForDate`, `saveMachineProgram*`,
  `removeMachineProgram*`, `deleteMachineProgram`, `setMachineProgramShift/SoleSlot`,
  `assignMachineContractor`, `listSoleColourOptions`, `listMachineProgramArticles/Uppers`) — no
  longer registered or exposed by the preload. (Phase 1.1 brought `assignMachineContractor` back,
  for the Machine Program's Change contractors, and added `addMachine`.)
* `useAddMachine` moved to `features/rawMaterial` (Raw Material → Setup → Machines still adds machines).

## Kept on purpose, for a later migration

* **Tables** `machine_programs`, `machine_program_runs/lines`, carton-label, reconciliation, B
  conversion and upper-reconciliation tables, and all their history. Nothing was dropped.
* **Data and application layers** for programs (`machinePrograms.ts`, `machineProgramWrites.ts`,
  `machineProgramUseCases.ts`, …) and their tests. No screen can reach the planning writes any more.
* **Store In / Store Out** program screens (program lookup, Machine Program Issue, Dana issue, Carton
  In, Program Close / Reconciliation / B conversion) keep working for programs that already exist,
  so in-flight programs can finish. No new program can be created. Owner decision, 2026-10-13.
* `listMachineProgramDana` (Store Out's Dana issue reads it).
* `copy.machineProgram` strings and the planning screen's styles in `theme.css` (`mpx-` and its
  neighbours — not `mpo-`/`mpr-`, which Store In/Out use): the Machines panel still uses some
  strings; the rest is unused and can be removed once the Store program screens are retired.
