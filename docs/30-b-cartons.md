# B cartons — Reconciliation for EVR FIX

> Built 2026-10-12. Migration 074. Applies to FIX runs (EVR FIX: two soles, no upper) only —
> upper programs reconcile exactly as before (cut size / wastage / lost).

## The flow

```
Move Out prints 20 carton labels (EVR9 / BLACK)       0001 … 0020
Store In receives 10                                  0001 … 0010 back
Complete Program → Reconciliation → "B cartons: 10" → Generate B labels
  · 0011 … 0020 are VOIDED  (reason "Converted to a B carton (MP-…)")
  · 10 new labels EVR9 / MIX / 7/10, grade B, are printed:   [B] EVR9 · QR · 7/10 · MIX
Store In scans the 10 B cartons → 20 of 20 back → the program closes COMPLETE
```

A B carton came off the machine in mixed colours, so its colour label no longer told the truth.

## Rules (data layer: `machineProgramCartons.ts` → `convertFixCartonsToB`)

| | |
|---|---|
| Which labels | Printed for the run, not voided, never produced (no `qr_master` row), not converted before, and not themselves B. Highest serials first. |
| How many | 1 … the number not back (`bConversionProblem`, domain). |
| Atomic | One `BEGIN IMMEDIATE`: the voids, the new B batch, its link to the run (`machine_program_fix_carton_labels`) and the conversion records. |
| Never twice | `machine_program_b_conversions.original_qr_id` is the PRIMARY KEY. |
| Never counted twice | The original is voided, so Store In refuses it (`VOIDED`). |
| The plan | B batches never count toward "still to print" — they replace labels, they are not more of the plan. |
| Completing | Back = ordinary + B cartons stored in. All back → COMPLETE. While ANY EVR FIX carton is out the program cannot close at all — Complete stays disabled and the main process refuses (owner, 2026-10-12). |
| Grade | `qr_batches.grade = 'B'`, so a reprint prints B again and stock/billing can tell a B carton apart. |

## Not yet decided

* B cartons are NOT in any Contractor Ledger — no contractor is paid for B (owner, 2026-10-12). They
  still count as back for the program, so it can complete.
* B cartons are stock as the MIX colour variant of the article. Selling them at the B-type price is
  still chosen on the sale line, as today.
