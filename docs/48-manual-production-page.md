# 48 — Manual Production page, Complete today's production, Daily Production

Owner's request, 14 Nov 2026. Manual Production leaves the QR Generator and becomes a page of its own; the day can be
marked complete; Carton Stock says whether it is; the Dashboard gets a Daily Production card; every page gets a way
back to the Dashboard.

## Manual Production (Inventory → Manual Production)

Behind **Live Production**, like every other way of recording production, and written on the computer that holds the
**CARTON_STOCK** lease (PC1).

1. **Machine**: the same machine picker the QR Generator uses. A machine without both contractors cannot be chosen.
2. **Article**: every size (down) and every colour (across) at once, a box in each cell (`SizeColourGrid`, shared with
   Stock Adjustment). A size not made in a colour takes no quantity. Under a box: what is already saved today for
   that size and colour, and what this machine already has in the list. Dozens are typed; the domain's rule
   (`manualProductionCartons`: whole or half dozens, at most 5,000 per line) is checked on screen and again when saved.
3. **Production to save**: "Add to list" puts every typed box on the list for the chosen machine. The next article,
   the next machine, as many as needed. The same machine, size and colour added again replaces its line. The list
   is kept on this computer (local storage) for the day it was made only, until it is saved or cleared.
4. **Save production** asks first, then sends every line in one call (`saveManualProduction`). The data layer
   (`recordManualProductionBatch`) records them in **one transaction: every line or none**. Each line is exactly one
   `recordManualProduction`: its own `MAN-` number, its own `MANUAL_PRODUCE` movement, its machine's program for
   today, its contractors and rates. A refused line refuses the Save and says which line. Each line carries its own
   request id, kept until a definite answer, so a Save retried after a lost answer adds nothing.
5. **Manual production today**: the saved entries, Details and Summary, with Void (docs/42), unchanged.

## Complete today's production

A button at the top of the page. It is offered once production is saved and the list is empty (lines still in the
list would be left out of a day that says it is all in), and it asks first. The data layer
(`completeProductionDay`) decides the day from the clock (`businessToday`, Asia/Karachi), refuses a day with no live
entry, and writes one row; marking again returns the first mark.

**It moves no stock.** Every carton is already in the figure through its own entry. Production saved after the mark
still counts; the day stays marked complete, and is always read from the entries.

### How it is stored and travels

- Local migration **109**: `production_days` (id `production-day:YYYY-MM-DD`, so the same day is the same record on
  every computer; `business_date` UNIQUE; who, when, and the day's cartons and entries at that moment). The outbox
  learns `PRODUCTION_DAY`.
- It travels as the leased record **PRODUCTION_DAY** under **CARTON_STOCK** (`masterCapture`, `masterRecords`).
- Cloud migration **032** adds the type to `sync_aggregate_types` and `leased_record_types`. **Applied to production
  on 14 Nov 2026** (owner's authorisation; production migration history `20261114105620 032_production_day_records`).
  **Not applied to TEST.** Had it been missing, the mark would have waited as `UNKNOWN_RECORD_TYPE` on PC1 and the
  other computers would have kept saying Production not added (the lesson of 030, 12 Nov).

## Carton Stock: today's production box

Beside Total Carton Stock: grey, **○ Production not added**, until the day is completed; then green, **✓ Production
added**, with when and by whom. Read for today (`getProductionDayMark`), every 30 seconds and at once when sync brings
carton data. Open to anyone signed in.

## Daily Production (Dashboard card, Inventory → Daily Production)

One day at a time (‹ › and a date, never past today): the day's dozens, cartons, machines and entries; then **All
machines** or one machine at a time, each article as the same Size × Colour matrix Carton Stock draws, with totals per
size, per colour and the article's. Voided entries are left out. Read through `getProductionDay`
(`productionDayView`), open to anyone signed in; the page itself is behind Daily Production.

The scan-based day report that page used to be (`production_events`, carton QR scanning, on hold) is kept as
**Scanned Production**, under the same permission.

## Dashboard button

Every page but the Dashboard has a **Dashboard** button beside the logo in the page header (the Store page's own
header too). On a narrow screen it shows its icon only.

## Today's production as a matrix, and Edit (owner, 14 Nov 2026)

"Manual production today" on the Manual Production page has two sections:

- **Production** (first): each machine, then each article as the same Size × Colour card Carton Stock and Daily
  Production draw (`CartonMatrixList`), with totals per size, per colour and the article's. Read through
  `getProductionDay` for today, so it always agrees with Daily Production. Each card has **Edit**.
- **Entries**: the saved entries line by line, newest first, with **Void**, as before. Voided and edited entries are
  marked here in words. (The old Summary list is gone: the matrices replace it.)

**Edit** opens the article's grid for that machine with today's dozens in the boxes (`getManualProductionArticle`).
Change any box, clear it or type 0 to remove it, review the changes ("7/10 BLACKRED: 5 → 3 dozen"), and save.

The owner's rule: "old stock 10, production 5, stock 15. Edit 5 to 3: stock 13, and the Contractor Ledger shows 3.
Reverse the first production and add the new one." That is what `editManualProduction`
(`database/manualProductionEdit.ts`) does, in **one transaction: every changed figure or none**. For each size and
colour whose figure changes:

1. the new figure is recorded as a new entry: the same call Save makes (`recordManualProductionInTransaction`): its
   own `MAN-` number, the machine's program for today, the rates in force;
2. every live entry that made the old figure is voided: the same call Void makes (`voidManualEntryInTransaction`), its
   reason saying what it became ("Edited on the Manual Production page: 5 dozen became 3 dozen (now MAN-000012).").

Recorded first and voided second, so only the **difference** must still be in the store; a change that would take
out cartons already gone is refused, naming the gatepass. A figure already equal to what is asked is left alone, so a
retried Save changes nothing twice.

**Today only.** An edit is recorded now, so it corrects today. An earlier day stays Void-only, for an administrator.
Same permission (Live Production) and same computer (the carton lease) as Save and Void.

## Download PDF (owner, 14 Nov 2026)

A minimal A4 report of a day's production (`productionReport.ts`): the logo, "Daily Production" and the day, whether
it was completed and by whom, four totals (dozens, cartons, machines, entries), then each machine with its articles as
Size × Colour tables in dozens (a dash where nothing was made), and, for more than one machine, all machines together.
No rates, money or entry codes.

- **Daily Production page**: Download PDF beside the machine tabs: the whole day under All machines, or the machine
  chosen.
- **Manual Production page**, Production section: Download PDF for today, and one per machine.

The person chooses where to save it; the main process renders it in a hidden, sandboxed window and writes the file
(`savePdfDocument`, `main/pdfFile.ts`, shared with the Rate List's PDF).
