# Machine Move Out — Store Out against a Machine Program

> Built 2026-10-10. Extends the existing Machine Program (docs/24) and Store Out (`features/store`)
> modules. Nothing in either was rebuilt, and the generic store scanner's behaviour is unchanged.
>
> **Revised the same day**, after the first version was tried on the floor: a scan now issues the
> packet there and then instead of building a batch to save, and the cartons the machine will send
> back are offered for labelling. The sections below describe the screen as it stands; the
> transaction underneath is the same one, called once per scan.

## What this adds

Until now a machine program was consumed in exactly one way: the storekeeper scanned a packet on
the generic Raw Material Output station and the business layer reconciled it, by itself, to the
**oldest** program still owing that upper (FIFO, migration 050). The storekeeper was never asked
which program a packet was for — the 2026-09-22 rule that the store scanner stays generic.

That rule is intact. What is new is the **other direction**: the storekeeper **opens** a program
and issues against it, and only the uppers that program authorises may go out through it.

```
Production saves MP-000012
        ↓ one notification, in the same transaction as the program row
Store Out operator opens it (notification, the lookup box, or the sheet's QR)
        ↓
MP-000012 — Machine Move Out   SK6 7/10 BLACK   100 DOZEN   30 issued   70 remaining
                               SK6 7/10 RED      50 DOZEN   10 issued   40 remaining
        ↓ scan a packet the program authorises
Stock moves NOW — ONE transaction, stamped with its allocation and its saved batch.
        ↓
Cartons to label               SK6 / 7/10 / BLACK   4 cartons   [Print Carton QR]
```

Everything else is refused: a packet of an upper this program does not ask for, or one it has
already had all of, stays on the shelf and the scanner says why.

## The three doors

All three resolve to the same `OpenMachineProgramForStoreOutUseCase`, so a program that is
deleted, finished or still empty is refused identically whichever way it arrived.

| Door | Carries | Where it is decided |
|---|---|---|
| Notification | the program's **stored id** (`user_notifications.entity_id`) | `notificationTarget` → `store-out-operator`, then the main process |
| Lookup box | whatever was typed or scanned | `parseMachineProgramLookup`, then the main process |
| The Scan Out station | a program code typed into it by the scanner | `isMachineProgramCodeScan` in `RawMaterialOutputPage.submitScan`, handed up to the lookup |

The third door is not a convenience — it is the one that made the feature work on the floor. The
embedded Scan Out station takes the keyboard focus as soon as its issue session opens, so the
program sheet's QR lands **there**, not in the lookup box, however the lookup is armed. Before
this it was refused as "not a raw material QR" and the program could not be opened by scanning
at all. The station now recognises the unmistakable `MP-…` form and passes it up; a bare number
is a mis-scan and is never claimed.

The lookup takes the number however it is written — `MP-000012`, `MP000012`, `mp 12`, `000012`,
`12` — and the stored id. **Anything else is a refusal, never a guess**: a raw material label
typed into the box is `INVALID_LOOKUP`, not a program.

The printed program sheet now carries a **QR of its own code** (`renderQrSvgMarkup(program.code)`,
the same renderer the raw material labels use), so scanning the sheet gives the lookup box exactly
what a storekeeper would have typed.

### Why "issued" means "created"

The requirement says "when a Machine Program is issued". There is no separate issue action in the
schema — a program is built up one upper line at a time, and each save is its own write. The
program **row** being created is the only once-per-program atomic event, and it is the moment the
program first reserves stock, so that is where the notice is written (inside
`SaveMachineProgramLineUseCase.programForDate`, in the same transaction). Adding more uppers later
sends nothing: the notice opens the program, and the program always shows what is outstanding now.

Recipients are `PERMISSION.STORE_SCANNING` — exactly who the Store Out page is open to.

## One scan, one movement

A scan **is** the issuance. There is nothing to press first and nothing to press afterwards, so a
packet can never be in the state the first version made possible — scanned, believed gone, and
still on the shelf because Save Batch was never pressed.

`SaveMachineProgramBatchUseCase` is still the only thing that writes, and the screen calls it
once per scan with a batch of exactly one packet and a key of its own. Everything that made a
batch safe therefore protects a single scan: all-or-nothing, re-validated in the lock, and
idempotent on `batch_key`.

`CheckMachineProgramScanUseCase` remains as the **read-only probe** — the same rules, in the same
order, writing nothing. Machine Move Out no longer calls it: asking first and committing second
would only let the answer go stale between the two calls.

The write goes through the **same** `issueRawMaterialPacket` body — the one function that debits
raw material stock — so there is no second deduction path:

```
IssueRawMaterialScanUseCase ─┐
                             ├─→ issueRawMaterialPacket(deps, { …, binding }, tx)
SaveMachineProgramBatchUseCase ┘        ↑
                                   binding.mode
                                     AUTO    = FIFO across programs (the generic scanner)
                                     PROGRAM = only the open program's allocations
```

`binding.mode = PROGRAM` is the central rule: `findOutstandingMachineProgramLineOfProgram` is
scoped to one program, and a packet it finds nothing for is refused `NOT_ON_PROGRAM`. The
cross-program FIFO is deliberately dropped in this mode — **the operator named the program, and
that is a stronger instruction than which program's date came first**.

### Every rule is enforced in the lock

Nothing is judged on the screen. Every rule below is checked inside the transaction that moves
the packet, so two terminals scanning the same packet cannot both win:

| Rule | Where it is enforced |
|---|---|
| is a raw material label at all | `checkRawMaterialScanFormat` |
| registered, not voided, in the store, has packing | `issueRawMaterialPacket` |
| the program authorises this upper, and still owes some of it | `findOutstandingMachineProgramLineOfProgram` (`outstanding > ε`) |
| the program is still eligible | `machineProgramStoreOutRefusal` |
| no duplicate inside one call | `SaveMachineProgramBatchUseCase` (before any write) |
| not taken by another terminal | `setRawMaterialQrStatus(expectedStatus)` |
| operator may issue at all | `resolveStoreOperator` in `ipc/store.ts` |

A packet is **indivisible**, so the last packet against a line may overshoot what that line still
owes (a 5 DOZEN packet against a line owing 2). That is existing behaviour and is preserved. The
rule is only that *something* is still owed before another packet is accepted.

### Partial, atomic, and safe to retry

* **Partial is the normal case.** Eight packets out of a program's twenty leaves the program
  `PROGRAMMED`, showing as `PARTIALLY_USED` (derived, never stored). The program is simply opened
  again later and scanning continues — every scan adds to what has left and never overwrites it.
* **All or nothing.** The packet is issued inside one `BEGIN IMMEDIATE`. A refusal anywhere
  throws, the transaction rolls back, nothing left the store, and the scanner says why.
* **Idempotent.** The screen makes a `batchKey` for each scan and the commit reads it inside the
  lock first. `machine_program_issue_batches.batch_key` is `UNIQUE`, so a request that arrives
  twice — a double click, a reply lost on the way back — reports `ALREADY_SAVED` instead of
  issuing the packet again.
* **A program is never completed by the act of saving.** `issueRawMaterialPacket` closes it only
  when `machineProgramIsFullyConsumed` is true, from the event log.

## The cartons the machine owes back

Uppers going out are cartons coming back. The store knows it the moment a packet leaves, so the
labels for the finished goods are offered right there instead of being worked out again later on
the QR Generator screen.

```
2 DOZEN of uppers issued
   → 1 dozen is 2 cartons of 6 pairs      (units.ts, unchanged since the beginning)
   → 4 cartons coming back
   → 4 carton QR identities to print
```

Three things have to be known before a label can exist, and each one is settled in the data layer
on the line the packet was issued against — never on a screen:

| | Where it comes from |
|---|---|
| which product | the run's `article_size_id` → `SK12 / 7/10` |
| which colour | the **upper's own** `colour` attribute (`COLOUR_SQL`), e.g. `BLACK RED` |
| how many | `cartonsExpectedFromUppers(quantity, unitCode)` in `@erp/domain` |

The colour is the upper's, not the sole's: two uppers on one sole run are two different cartons
of the same article, and the sole colour would print them both the same. The sole colour is still
reported, for recognition only.

**Nothing is guessed.** `cartonsExpectedFromUppers` returns null unless the quantity is in DOZEN
and comes to a whole number of cartons, and an upper with no colour on it has no carton identity
at all. In either case the packet still leaves the store — that is the store's business — and the
screen says, in its own sentence, why these cartons have to be generated in QR Generator instead.
A carton QR is a permanent identity; a rounded or invented one would be worse than none.

### Printing is the QR Generator's own call

The labels are generated through `generateQrBatch` — the one place carton identities are created
— so they are ordinary carton QRs from the moment they are printed, with the same batch row,
sequence counter, product variant and QR Management history as any other run. The program's code
is recorded as the run's `requested_by`.

It is authorised the way the QR Generator always was, by `PERMISSION.QR_GENERATOR`, which the
`store-operator` role already holds. Nothing about carton generation is loosened for this screen.

On the screen the pending cartons are **grouped by product and colour**, because that is what one
QR run is: two packets of the same upper scanned one after another are one run of eight labels,
not two of four. A printed run is struck off the list with the identity range it reserved
(`SK12_BLACKRED_7/10_000001 → …_000008`), and a blocked print window does not undo it — the codes
exist and QR Management can reprint them, which is what the operator is told.

## Database changes (migration 062)

Two things had nowhere to live. Everything else this feature needs already existed.

```sql
CREATE TABLE machine_program_issue_batches (
  id, batch_key UNIQUE, program_id, session_id, device_id, issued_by,
  packet_count CHECK (> 0), created_at
);
ALTER TABLE raw_material_qr_events ADD COLUMN machine_program_batch_id;
```

* `batch_key UNIQUE` **is** the retry safety.
* `machine_program_batch_id` sits beside the existing `machine_program_upper_line_id`. The line
  stamp answers *which program authorised this packet*; the batch stamp answers *which Save Batch
  committed it*. The issue **session** cannot answer that — it is the terminal's whole run, and a
  program is issued over several batches across several days.

No quantity is stored anywhere here. Issued and remaining are still recomputed from
`raw_material_qr_events` by `LINE_CONSUMED_SQL` every time they are asked for.

## Traceability

One `STORE_EXIT` row answers all of it:

| Question | Column |
|---|---|
| which Machine Program authorised this QR | `machine_program_upper_line_id` → run → program |
| which Store Out batch recorded it | `machine_program_batch_id` |
| which operator | `actor` |
| when | `event_ts_local` |
| which variant, what quantity | `item_id`, `quantity`, `unit_id` |
| completed, or still partial | the program's status + `LINE_CONSUMED_SQL` |

Plus one `audit_log` row per saved batch (`MACHINE_PROGRAM_STORE_OUT_BATCH_SAVED`), carrying the
key, the session and every QR in the batch.

A packet received back into the store writes the compensating `STORE_ENTRY` carrying the **same**
line stamp, so the quantity returns to the program's outstanding — unchanged by this feature.

## The screen

One scan target at a time. Opening a program **replaces** the two Move Out panes, because a
hardware scanner types into whichever box has focus and two armed boxes would send a packet out
through whichever one happened to have it. Closing the program puts the page back exactly as it
was, and the station resumes the terminal's open session from the database.

The scan box is armed for as long as the program may be issued against, and stays armed while a
scan commits so a scanner burst is never dropped; the scans are serialised in the panel, one
transaction at a time. A refusal never ends the session.

Two lists sit under the program, whether the scanner is open or not:

* **Cartons to label** — every packet of uppers out for this program that has not had its cartons
  printed, as carton runs (one product and colour each) with one Print button each, plus the runs
  already printed and any packet whose cartons could not be worked out. Read from
  `raw_material_qr_events` through `listMachineProgramCartonPackets`, so it covers earlier
  sittings, other terminals and packets the plain store scanner issued against the program.
* **Already issued** — every packet that has ever left for this program, read back from
  `raw_material_qr_events` through `listMachineProgramIssueBatches`, with its carton count. It is
  the same list whoever opens the program and whenever, so cartons missed in an earlier sitting
  can still be worked out from it.

The authorised-uppers table is deliberately **flat** — article, size, sole, upper, authorised,
issued, remaining. The storekeeper is fetching packets, not reading a production plan, so the
injector and run the Machine Program screen groups by are not shown. Every figure on it is the
program re-read from the event log after each scan; nothing on the screen is patched.

## Files

**Backend**

| File | Purpose |
|---|---|
| `migrations/sqlite/062_*.{up,down}.sql` | the batch table and the event stamp |
| `packages/domain/src/constants.ts` | `NOTIFICATION_KIND.MACHINE_PROGRAM_ISSUED` |
| `packages/domain/src/machineProgram.ts` | the lookup parser (moved here from the use case, so the screens can share it), `isMachineProgramCodeScan`, `cartonsExpectedFromUppers`, `MachineProgramCartonTarget` |
| `packages/application/src/rawMaterialIssueUseCase.ts` | **refactored**: the per-packet body extracted as `issueRawMaterialPacket`, with `IssueProgramBinding` |
| `packages/application/src/machineProgramStoreOutUseCases.ts` | **new**: lookup parser, open, check, save batch |
| `packages/application/src/rawMaterialReceiptUseCase.ts` | two repository requirements added |
| `packages/application/src/machineProgramUseCases.ts` | the notice on program creation |
| `packages/data/src/database/machineProgramStoreOut.ts` | **new**: the four reads and the batch writes; the program-scoped line read also returns the run's carton target |
| `packages/data/src/database/machineProgramWrites.ts` | `notifyMachineProgramIssued` |
| `packages/data/src/database/rawMaterialQr.ts` | the batch column on the event insert |
| `apps/desktop/src/main/ipc/store.ts` | four handlers, behind `resolveStoreOperator` |

**Renderer**

| File | Purpose |
|---|---|
| `features/store/programOut/programOut.ts` | row shape, formatters, carton run grouping, verdict → feedback |
| `features/store/programOut/useProgramOut.ts` | the open program, the per-scan movement, the carton print |
| `features/store/programOut/ProgramLookupField.tsx` | the compact lookup at the top of Store Out |
| `features/store/programOut/ProgramOutPanel.tsx` | the workspace |
| `features/store/programOut/ProgramOutLines.tsx` | the authorised-uppers table |
| `features/store/programOut/ProgramOutCartons.tsx` | the cartons to label, and the issued history |
| `features/store/StoreOutPage.tsx` | the lookup, and the program panel in place of the panes |
| `pages/RawMaterialOutputPage.tsx` | `onMachineProgramScan`: a program code scanned into the station is handed up |
| `features/users/notificationTarget.ts` | the new target |
| `app/App.tsx` | the arrival program |
| `features/machineProgram/machineProgramPrint.ts` | the program's QR on the sheet |

## Tests

`packages/data/src/machineProgramStoreOut.test.ts` — 22 cases against a real SQLite database, with
stock built the only way it can be (QR Generator → Raw Material Input) and every figure read back
through the repository the screens use. The two-terminal case opens a **second connection to the
same file**, which is what two store computers actually are.

The last three pin the cartons down where they are decided: the plan a saved packet reports, the
upper's colour (not the sole's) deciding the carton identity, and an upper with no colour that is
still issued but carries a sentence instead of a label.

`apps/desktop/src/renderer/features/store/programOut/ProgramOut.test.tsx` — 11 cases: all three
doors (including a program sheet scanned into the station that holds the focus), a refusal shown
rather than worked around, a packet that leaves the store on the scan itself, a rejection that
moves nothing and leaves the session armed, carton runs grouped and generated to the exact count,
and a packet whose cartons are refused rather than guessed.

## Known limitations

A packet may overshoot the last of a line's outstanding quantity, because a packet cannot be
split. This is pre-existing behaviour of the generic scanner and is preserved deliberately rather
than refused — refusing it would leave the program unable to finish. A carton count follows the
packet, so an overshooting packet offers the cartons its own quantity implies.

**Printing cartons is recorded, exactly once** (migration 068, `machine_program_carton_labels`).
`printMachineProgramCartons` re-reads the chosen packets inside BEGIN IMMEDIATE, works the count
out from them (1 DOZEN = 2 cartons — the screen never sends a number), reserves the carton QR run
and writes one label row per packet in the same transaction. The row is keyed by the packet's
STORE_EXIT event, so the same issuance can never be labelled twice from any terminal, and a packet
returned and issued again is owed its own cartons. A packet that came back to the store before its
cartons were printed is no longer offered. Printing needs QR Generator on top of Store Scanning.
A lost print window loses nothing: the codes are registered and can be reprinted from QR
Management.

## Store In: the cartons coming back

Store In has the same Machine program lookup. It opens any program read-only (no Dana Issue, no
Upper Out) and adds **Carton In**: the storekeeper scans the program's printed carton labels as the
machine sends them back.

* `ReceiveMachineProgramCartonUseCase` first checks, through `machine_program_carton_labels`,
  that the label was printed for the program that is open. A label printed for another program is
  refused with that program's number. An ordinary QR Generator label is refused and sent to
  Store Move In. Nothing is written for a refusal.
* It then runs the production step and the Store Move In step in ONE transaction. These are
  `recordProductionInTransaction` and `receiveIntoStoreInTransaction`, the same functions
  Live Production and Store Move In run. The carton is produced and stored in together, or not at
  all. A carton already scanned in Live Production is only stored in.
* Each printed run shows how many of its cartons are back (`receivedInRun`, counted from the
  STORE_ENTRY events), re-read after every scan.

## Completing a program, and reconciliation

Store In closes a program with **Complete Program**, once production is over.

* **Due** is what was issued, in cartons (1 DOZEN = 2 cartons, so 4 DOZEN is 8 cartons). **Back** is
  what Carton In stored in. Both come from `listMachineProgramCartonProgress`.
* **All back:** a confirmation, and the program closes **COMPLETE**.
* **Short:** the reconciliation opens. Each missing carton is 6 uppers, and every upper must be
  accounted for in exactly one of three ways:
  * **Cut size**: the upper came back to the store.
  * **Wastage**: it was damaged, and is claimed to the upper's **supplier**. The suppliers offered
    are those whose packets went out for that line.
  * **Lost**: it was lost on the floor, and is claimed to the **machine** or the **packing**
    contractor.

  Every claim needs its party and a **reason**. The program then closes **RECONCILED**, and every
  approved administrator gets a `MACHINE_PROGRAM_RECONCILED` notice that names each claim and its
  reason.
* Reconciliation is counted in **uppers (pairs)**, never dozens. 4 uppers is a third of a dozen,
  which a two-decimal dozen can't hold exactly. The rule is `reconciliationEntryProblem` in
  `@erp/domain`. The screen uses it to say what is still missing, and
  `completeMachineProgramProduction` applies it again inside the write lock, against the shortfall
  it works out itself. The table's CHECK constraints hold the same sums.
* Closing writes `machine_program_closures` and `machine_program_reconciliation_lines` (migration
  069) and sets the program **COMPLETED** in one transaction. COMPLETED holds no reservation, so
  uppers planned but never issued are released. A program can be closed once only.
* **Closed is final.** Carton In, new label printing, Dana Issue and Upper Out all refuse a closed
  program by name. Reprinting an existing label is still allowed, because it creates nothing. Store
  Out shows how the program was closed, which is where an administrator's notice opens it.
* **Not yet done:** cut-size uppers are *recorded*, but not added back to the upper's stock. Uppers
  are kept as labelled packets, counted in dozens, so loose returned pieces need a decision on how
  they re-enter stock.
