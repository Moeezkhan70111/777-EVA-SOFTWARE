# Contractor Ledger

> Built 2026-10-12. Finishes what docs/28 left for "when production comes". Read-only: no
> migration, nothing stored — the ledger is worked out every time it is read.

## What it shows

One contractor's account for a period, the way a ledger reads:

```
Date     Particulars                    Qty      Earned (Cr)   Paid (Dr)   Balance
         Opening balance                                                   700.00
12 Oct   ▸ Production · MP-000011       10 DZN   700.00                    1,400.00
14 Oct   Payment · CV-000045 · Cash                            500.00      900.00
```

A production day opens to its detail — program, machine, job, article, quantity, rate and the
sum written out: `10 DZN × Rs 70.00 = Rs 700.00`.

## The rules (all in `packages/domain/src/contractorLedger.ts`)

| | |
|---|---|
| **Work** | NOT a B carton (grade B, migration 074) — no contractor is paid for B. Otherwise: a carton printed for a machine program (`machine_program_carton_labels` / `machine_program_fix_carton_labels`) that Store In has received — its first `STORE_ENTRY`. The same fact the program screen counts as "back". |
| **Date** | The day it was received, in Asia/Karachi (`businessDateOf`), not the UTC date. |
| **Quantity** | 2 cartons = 1 DOZEN (`cartonsToDozens`). Every rate is per DOZEN. |
| **Who earns** | The program's machine contractor earns the machine rate; its packing contractor the packing rate. One person holding both on a program gets both lines. Printing has no contractor yet, so it goes to one **Printing Contractor** ledger. |
| **Rate** | What the program agreed for the article (`machine_program_article_rates`); else the product's standard rate (`article_sizes.*_rate_paisa`); else **Not priced** — shown and counted in dozens, never added as 0. Every line says which rate it used. |
| **Payments** | Active cash vouchers naming the contractor (header or line). A payment is a debit; money received back from the contractor is a credit. |
| **Balance** | Positive = owed to the contractor. Everything before the period is the opening balance. |

Money is integer paisa throughout; each line is rounded once (`jobChargePaisa`), and a day is the
sum of its lines.

## Known limits

* Using the product's standard rate as a fallback reads it **live**: if a program was never priced
  and the product's rate later changes, that program's past lines change with it. Pricing the
  program fixes its figure for good.
* The printing ledger has no payments until a printing contractor party exists.
* Access needs the `contractor-ledger` permission; both reads are checked in the main process.
