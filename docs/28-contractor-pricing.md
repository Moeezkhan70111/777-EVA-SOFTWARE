# Contractor pricing — products and machine programs

> Built 2026-10-11. Extends the Machine Program (docs/24) with what its work is paid at.
> Migrations 063 (the program's rates) and 064 (the product's standard rates). Nothing about
> reservations, stock, Store Out or the program's own figures changed.

## What this adds

A machine is run under one contractor and its output packed under another (migration 059), and
until now the program said nothing about what either of them is paid. It does now — per ARTICLE,
per DOZEN, in three rates:

```
+ ADD ARTICLE                                              MACHINE 1
① Sole Color    ② Article & Size    ③ Upper Stock
④ Contractor Pricing — SK6 / 7/10
   Machine rate [ 45.00 ]   Packing rate [ 18.00 ]   Printing rate [ 12.00 ]   per DOZEN

PROGRAM SUMMARY                                        [ Edit Pricing ]
  Article        Machine   Packing   Printing   For the program
  SK6  7/10        45.00     18.00      12.00         7,500.00
  SK12 1/6         52.00     20.00       0.00         3,600.00
  Total at these rates                               11,100.00
```

Three jobs, because that is how a dozen is paid for on this floor: running the machine, packing
what it makes, and printing.

## Two places, one meaning

The rates live in two places on purpose, in exactly the relationship a sale voucher has with a
selling price:

```
Product Master  (article_sizes, migration 064)
  SK6 7/10   sale 650.00   machine 45.00  packing 18.00  printing 12.00     THE STANDARD
        ↓ defaults into
Machine Program (machine_program_article_rates, migration 063)
  MP-000011 · SK6 7/10      machine 45.00  packing 18.00  printing 12.00    WHAT THIS DAY PAYS
```

* **Add / Edit Product** has a *Contractor Pricing* section beside *Pricing*: what this product's
  work is normally paid. Master data, changed when the deal with the contractors changes.
* **A machine program** opens its pricing boxes on that standard and then **keeps its own copy**.
  Changing a product's rate later never rewrites a day already priced — the same reason a sale
  voucher keeps the rate it was billed at.

The precedence, decided in one place (`useChosenUppers.rateFor`):

| | |
|---|---|
| 1 | what the operator has typed on this screen |
| 2 | what THIS program already pays for the article |
| 3 | the PRODUCT's standard rates |

Whatever is showing is what gets saved onto the program, so the program always ends up owning its
figure — a default that is never confirmed is never silently relied on later.

**Why on `article_sizes` and not on `product_variants`:** price lives on the ArticleSize because
colour variants share it (migration 031), and a machine program run points at an
`article_size_id`. A carton's colour has no bearing on what moulding a dozen is paid, so unlike
the prices there is nothing to copy onto the variants and nothing that can fall out of sync.

## The four decisions behind it

All four are the owner's (2026-10-10/11), and none of them is recoverable from the code alone.

| Decision | What was chosen | Why it matters |
|---|---|---|
| What the rates belong to | **Each article on the program** | A bigger slipper is more work, so one rate for the whole day would be wrong. The product carries the standard (above) and the program carries what its own day pays. |
| The unit | **Per DOZEN** | The program's upper lines are already in DOZEN, so 10 DOZEN × Rs 45 needs no conversion. |
| Who printing is paid to | **Nobody yet — just a rate** | There is no printing contractor on a machine. The cost is recorded so it is not lost, and a party can be attached later without touching what is stored. |
| How far to go | **Rates and amounts, no ledger** | See below. |

### The ledger waits for production

The first answer was "also post to the contractor's ledger", and then: *"it will be done when
production comes."* That is the rule this is built to:

```
rate × quantity = what is owed
                  ↑
         PRODUCED quantity, which this ERP does not yet record against a program
```

A contractor earns on what the machine actually made. The program is the agreement, not the work,
so **nothing is posted anywhere and no amount is stored**. The figure the screens show is labelled
*For the program* and *Total at these rates*, and the note under it says in words that what is
owed is settled when production is recorded. It is never called "owed" or "payable".

What makes that cheap to finish later: the arithmetic takes a quantity and knows nothing about
where it came from.

```ts
contractorChargeFor(rates, dozens)   // today: the programmed quantity
                                     // later: the produced quantity, same function
```

So when production is recorded against a program, the ledger work is a new source that calls the
same function — not a rewrite of how pricing is stored or shown.

## One row per article, not per run

```sql
CREATE TABLE machine_program_article_rates (
  id, program_id, article_size_id,
  machine_rate_paisa, packing_rate_paisa, printing_rate_paisa,
  created_by, created_at, updated_at,
  UNIQUE (program_id, article_size_id)   -- via idx_machine_program_article_rates_article
);
```

The same article can be moulded on two sole colours, or on both injectors. To the person paying
it is one article at one rate, so the unique index is the rule: **two runs of SK6 7/10 can never
drift to two different machine rates.** Pricing an article again is a change (`ON CONFLICT … DO
UPDATE`), never a second price.

Money is **integer paisa** (R15) and there are no REAL rupee siblings — the table is new, so it
starts where the rest of the books are going. 45.00 per dozen is `4500`.

### Unpriced is not zero

This is the rule the whole feature is built around, and it holds in both tables: a NULL column on
a product and a missing row on a program both mean **unpriced**, while a stored **0** means that
job is not paid for this article (printing on a plain slipper). Nothing in the system blurs them:

* An empty box on the product form saves **null**, not 0 — in the renderer, in the IPC handler
  (`contractorRates`, which reads a non-finite value as null rather than coercing it) and in the
  column, which has no default.
* A product with no rates at all offers a program **nothing**, so its boxes open empty rather than
  at zero, and the article stays unpriced if nobody types anything.
* A product with SOME rates set answers with zeros for the missing ones, because the operator is
  about to see and confirm all three.


* `programContractorPricing` gives an unpriced article `rates: null` and `committed: null`, adds
  nothing to the total, and counts it in `unpricedArticles`.
* The screen and the sheet print **"Not priced"** in words, never a dash or a 0.00.
* The rail says "1 article not priced yet" under the table.

A total is therefore always the total of what *is* priced, and the reader is told what is missing
from it rather than being shown a figure that quietly assumed zero.

## Where the arithmetic lives

`packages/domain/src/contractorPricing.ts`, and nowhere else:

| | |
|---|---|
| `contractorChargeFor(rates, dozens)` | one article's charge, each job rounded to the paisa on its own multiplication so the three figures shown always add up to the total shown under them |
| `programContractorPricing({ runs, rates })` | the whole program's table: one row per article, its runs summed, plus the totals and the unpriced count |
| `isValidContractorRatePaisa` | 0 or more, whole paisa, at most Rs 100,000 per dozen — mirrored by the table's CHECK constraints |

The program screen, the pricing dialog and the printed sheet all call
`programContractorPricing`, so the sheet in a contractor's hand and the screen the munshi is
looking at cannot show two different figures.

## Two places a rate is typed, one component

| Where | When it is used |
|---|---|
| `AddArticleDialog`, panel ④ | while the article is being added — the rates go on in the same gesture |
| `ContractorPricingDialog`, from Program Summary | afterwards, for an article already on the program, without having to add an upper to reach the boxes |

Both use `ContractorRateFields` (R1), so the three rates are entered, checked and worded
identically. Both open on **what the program already pays**, not on empty boxes.

### What is actually sent

* Rates arrive at the main process as **rupees as typed**; `toPaisa` and the validation are in the
  use case, so the renderer never does money arithmetic.
* In the add dialog, the pricing is saved **after** the upper lines, because an article can only be
  priced once it is on the program. A refusal there is reported differently from a refused line:
  the uppers *are* on the program, so the operator is told to set the pricing from Program Summary
  rather than left thinking nothing saved.
* Only what **changed** is sent. Re-opening the pricing dialog and pressing Save writes nothing,
  and an untouched article is never re-written with the values it already had.

## Rules enforced in the write lock

| Rule | Where |
|---|---|
| the program still exists, and is not deleted | `requireOpenProgram` — the same guard every other program write uses |
| the article is actually ON the program | `machineProgramHasArticle` → `ARTICLE_NOT_FOUND` |
| a rate is whole paisa, ≥ 0, ≤ Rs 100,000/dozen | `areValidContractorRates` → `INVALID_RATE`, before the transaction opens |
| who priced what, and what it was before | one `audit_log` row per save (`MACHINE_PROGRAM_ARTICLE_PRICED`), carrying `from` and `to` |

The audit row is the point of being able to prove, later, what a day's work was agreed at.

## Files

**Backend**

| File | Purpose |
|---|---|
| `migrations/sqlite/063_*.{up,down}.sql` | the rates table and its unique index |
| `packages/domain/src/contractorPricing.ts` | **new**: the three rates, the charge, one program's pricing table |
| `packages/application/src/machineProgramRatesUseCase.ts` | **new**: `SaveMachineProgramArticleRatesUseCase`, and the repository it needs |
| `packages/application/src/machineProgramUseCases.ts` | the `INVALID_RATE` outcome |
| `packages/data/src/database/machineProgramRates.ts` | **new**: the reads, the upsert, and the program's rate rows |
| `packages/data/src/database/machinePrograms.ts` | `articleRates` on the program record (`mapProgramWithRates`), and the standard rates on the article list a program defaults from |
| `migrations/sqlite/064_*.{up,down}.sql` | the three rate columns on `article_sizes` |
| `packages/data/src/database/products.ts` | the rates written by `createProduct` / `updateProduct` / `getOrCreateArticleSize` and read by `getProduct` (`contractorRatesInPaisa`) |
| `apps/desktop/src/main/ipc/products.ts` | `contractorRates` — an empty box is null, never 0 |
| `apps/desktop/src/main/ipc/machinePrograms.ts` | one handler, numbers read raw so a wrong rate is refused rather than coerced to 0 |

**Renderer**

| File | Purpose |
|---|---|
| `features/machineProgram/ContractorRateFields.tsx` | **new**: the three boxes, the draft, and why a draft cannot be saved |
| `features/machineProgram/ContractorPricingDialog.tsx` | **new**: every article on the program, priced |
| `features/machineProgram/ProgramPricing.tsx` | **new**: the read-only table in Program Summary |
| `features/machineProgram/AddArticleDialog.tsx` | panel ④ |
| `features/machineProgram/useChosenUppers.ts` | the rate drafts, and saving them after the lines |
| `features/machineProgram/machineProgramPrint.ts` | the pricing block on the A5 sheet |
| `features/machineProgram/machineProgram.ts` | `articleDefaultRates` — the product's standard, for an article the program has not priced |
| `pages/ProductFormPage.tsx` | the *Contractor Pricing* section, beside *Pricing* |
| `InjectorWorkspace` → `InjectorPanel` → `SoleGroup` → `SoleEditors` | `articleRates` threaded to the add dialogs |

## Tests

`packages/domain/src/contractorPricing.test.ts` — 8 cases on the arithmetic: exact paisa, the
three jobs adding up to their own total under a fractional dozen, zero as a real rate, two runs of
one article as one priced row, and an unpriced article adding nothing while being counted.

`packages/data/src/machineProgram.test.ts` — 10 new cases against a real database: the rates
stored as paisa and read back on the program, re-pricing replacing rather than duplicating, one
price across two sole runs, an article not on the program refused, a negative and an absurd rate
refused with nothing stored, a deleted program refused, the audit row's `from`/`to`, a product's
standard rates stored and offered to the program, an unpriced product offered as unpriced rather
than as zero, and a product's rate changing WITHOUT touching a program already priced.

`apps/desktop/.../ProductFormPage.test.tsx` — 4 new cases: the three rates saved with the product,
an untouched box sent as null rather than 0, an existing product opening on the rates it is priced
at (including a stored 0), and a rate above what the books take refused without saving.

`apps/desktop/.../MachineProgramPage.test.tsx` — 10 new cases: pricing typed while adding an
article (and saved after the uppers), an article left unpriced when neither the operator nor the
product has priced it, a negative rate refused before anything is sent, the rates and the
committed total shown from the saved program, "Not priced" in words, changing a rate afterwards
sending only what changed, the pricing on the printed sheet, the boxes opening on the PRODUCT's
standard rates and saving them onto the program, a day priced differently from the product, and
empty boxes for a product nobody has priced.

## Known limitations

* **No amount reaches any ledger.** By decision — production decides what is owed. A contractor's
  balance is unchanged by pricing a program.
* **Printing has no party**, so printing cost cannot be attributed to anyone yet. It is in the
  program's total and on the sheet.
* A program defaults from the **product**, not from yesterday's program. If the floor would rather
  have "whatever the last program paid" as the default, that is a deliberate addition.
* `listProducts` does not carry the rates — only `getProduct` does — so the product LIST cannot
  show or filter on them yet. The form, which is where they are set, reads `getProduct`.
