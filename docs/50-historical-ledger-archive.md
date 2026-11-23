# 50 — Historical ledger archive (Customer Ledger → Import old ledger)

Owner's request, 16 Nov 2026: bring the customer ledgers from the previous accounting software into 777 ERP, so that
one Customer Ledger screen shows a customer's whole history. The old entries keep their original details and are
marked as archived. The full ledger can be downloaded as PDF and Excel. **The archive must never touch the live
accounts.**

## One screen, one table

Customer Ledger keeps its layout. When a customer has archived rows in the chosen dates:

```
Date        No.       Type                 Bill No.  Description                                   Qty  …  Debit    Credit   Balance   Reference
30 Sep 2026 0         · -                  -         Opening Balance                                -       -        -        202,200   ARCHIVED
09 Oct 2026 11802     · Sale               14302     4 Dzn HR-1 7/10 EVR Gents@7920 Discount 1440   4       30,240   -        232,440   ARCHIVED
12 Oct 2026 RV-00001  · Receipt            -         Received on account                            -       -        50,000   -50,000   Cash
17 Oct 2026 3181      · Cash Voucher       -         received khawaja talal hassan meezan           0       -        300,000  480       ARCHIVED
```

- Live and archived rows sit in **one table, by date**. On the same day an archived row comes first. Each side keeps
  its own order (an archived row's original sequence, a live entry's place in the live ledger).
- An archived row says **Archived** in words, on a muted background. Its balance is the one the old software
  **printed**, in italics.
- **Search** covers both: voucher and bill numbers, descriptions, the type in words, the printed date. **Filter** has
  an extra choice, **Archived**.
- The live summary cards, the live opening-balance row, **Current Balance** and the live **Total** row are worked out
  exactly as before, from the ERP's own documents only. A separate **Archived total** row, and a **Previous software**
  strip above the table, show what the archived rows add up to and the last balance printed. That strip says it is not
  part of the live balance. It also links to the original PDF when one was kept.
- There is no separate page, tab or menu item.

## The data (local migration 111, `database/ledgerArchive.ts`)

- `ledger_archive_statements`: one customer's statement from one imported file. It holds the ERP customer, the old
  code and name, the period, the row count, opening and closing balances, total debit, credit and quantity, the import
  batch id, the file name and its SHA-256, the optional original PDF (name, hash, size), who imported it, when, and on
  which computer.
- `ledger_archive_entries`: its rows, in their original sequence. Each row holds the date (and its text as written),
  voucher number, type code, bill number, the full description (line breaks kept), quantity (and its text), debit,
  credit and the printed running balance. Amounts are integer paisa, with their printed text kept too.
- **Written once.** The application has no way to change or remove an archived row. A correction would be a new,
  audited statement (not built).

### Never accounting

Nothing that works out a balance reads these tables. `getCustomerLedgerWithCash` (`database/cash.ts`), customer
balances, the cash book, stock and the reports are unchanged. An import writes no voucher, number, stock movement or
party balance. `ledgerArchive.test.ts` checks this directly: every other table's row count, and the customer's live
ledger, are identical before and after an import.

## The import

A CSV (Excel → Save As → "CSV UTF-8"), one row per ledger line, one or many customers per file:

| Column | |
|---|---|
| `party_code` | the old software's code (or leave blank and give the name) |
| `customer_name` | as in the old software |
| `transaction_date` | DD/MM/YYYY (or YYYY-MM-DD); a two-digit year is refused |
| `voucher_number`, `transaction_type`, `bill_number` | as printed (`SL`, `CV`, `JV`, …) |
| `description` | as printed, in full; a cell may span lines |
| `quantity` | as printed; blank is fine |
| `debit`, `credit` | as printed: `30,240`, `-` for nothing; never both on one row |
| `running_balance` | as printed; `-480`, `(480)` and `480 Cr` are negative |
| `sequence` | 1, 2, 3 … per customer; blank keeps the file's order |

Headings are matched without regard to case, spaces or underscores, and the old report's own headings (`Date`,
`No.`, `Type`, `Bill.No`, `Qty`, `Balance`) work too. **Download blank template** gives the columns.

**Every row is checked, not just the totals.** Each running balance must equal the one before it, plus its debit,
less its credit. A row that breaks the chain is listed with the figures. Unreadable dates and amounts are listed by
line. A customer with any problem is held back whole: a gap would break their balances. Other customers are not
affected. An exact repeat of a row is flagged for a look but not refused.

**Matching the customer.** The ERP numbers its own parties (`PTY-…`), so the old code rarely matches. Each statement
is matched to an ERP customer in this order:

1. an earlier import of the same old code;
2. an ERP party code equal to it;
3. exactly one customer with the same name.

Otherwise the screen asks, and any match can be changed. Customers are never created by the import.

**Never twice.** The same file (by hash) is refused. So is the same statement for the same customer, and any statement
that repeats rows already archived for that customer. The screen's batch id makes a retry after a lost answer find what
it already wrote. **All or nothing:** the accepted statements are written in one transaction.

**Who.** The **Cash Voucher** permission, on the computer holding the **ACCOUNTS** lease, the same as writing a cash
voucher. Reading follows **Customer Ledger**. The main process re-reads every row with the same rules
(`@erp/domain` `ledgerArchive.ts`) and takes who imported it from the session.

### The original PDF

**Attach original PDF** keeps the file on the importing computer, in `ledger-archive-sources/` under the data
folder, named by its SHA-256. This follows the same rule as delivery proofs: a typed name never reaches a path.
The statement records the PDF's name and hash and travels. The file itself does not. **Open original PDF** opens it
with the computer's PDF viewer. On another computer it says the file is kept where it was imported.

### Reading a PDF automatically: not built

The old software's PDF has no text layer this ERP can rely on. Its numbers are cut off in the printed columns
("1204…"), and descriptions wrap across lines. Reading it without a PDF library would mean guessing, and the brief is
not to guess. The import therefore takes the CSV, and the original PDF is kept beside it. The reference file
`docs/fixtures/ledger-archive/behraam-shoes-1301139.csv` was typed from the reference PDF and checked row by row (below).

## Downloads

**Download PDF** writes the ledger in view: the chosen customer, dates, filter and search, every page, live and
archived together. It goes through the one PDF writer (`savePdfDocument`): A4 landscape, with the logo, customer,
code, period, the live figures and the table. Headings repeat on every page, no row is split across pages, archived
rows are marked ARCHIVED, live and archived totals are separate lines, and the page number is at the foot ("Page 1 of
2"). **Download Excel** writes the same rows through the one CSV writer, with a **Source** column (Live / Archived).
Amounts stay numbers and dates are YYYY-MM-DD.

## Sync (cloud migrations 034 and 041)

**In pages, from local 117.** A statement travels as the leased record **LEDGER_ARCHIVE_STATEMENT** under
**ACCOUNTS**, as its header alone, and its rows as **LEDGER_ARCHIVE_ENTRY_PAGE** records of up to 50 rows each
(`LEDGER_ARCHIVE_PAGE_ROWS`, `masterRecords.ts`), by the existing leased-record path. Nothing new is added to the
transport.
- **Why.** Before 117 a statement went as one record holding every row. The cloud refuses a record over 256 KB
  (`RECORD_TOO_LARGE`, about 480 rows), and the import accepts 5,000. On 22 Nov 2026 a long ledger imported on PC1 was
  refused that way and never reached PC3.
- **Size.** The longest statement the import accepts (5,000 rows, every row at its longest, with a 1,000-character
  Urdu description) is 100 pages. Its largest page is 137 KB as the cloud measures it, about half the limit
  (`ledgerArchivePagesSync.test.ts`).
- **Page ids** are the statement's id and the page number (`<id>:p<n>`, `ledgerArchivePageId`), the same on every
  computer.
- **Shown only when whole.** A receiver shows a statement, in its ledger and in the reconciliation, only once every
  row is here (`row_count`, `archiveStatementShownSql`). A page that arrives before its statement waits for it.
- **A withdrawal** is the header alone: no page is sent again.
- **The upgrade (local 117).** Every stored row is given its page, on every computer, with the same ids. On the
  computer holding ACCOUNTS the statement and its pages are marked to be sent again. A statement revision built the old
  way and never delivered (the RECORD_TOO_LARGE dead letter) is retired: kept, marked SYNCED, with a note saying why.
- **Order.** Apply cloud 041, then install the release on **every other computer first**, and on the accounts
  computer last. A build without 117 refuses a page as an unknown type, permanently, and moves past it: it would never
  show those rows, even after upgrading.

Duplicate delivery is the existing revision rule. A computer that receives it shows it on its Customer Ledger.

**Apply cloud 034 before the release carrying local 111 reaches the accounts computer.** Until then an imported
statement waits as `UNKNOWN_RECORD_TYPE`, and nothing else is held up. **034 is prepared, not applied** to either
project.

## The reference: Behraam Shoes Karachi (1301139)

`behram shoes.pdf`, 01/10/2026 to 14/11/2026, two pages, 45 rows (the opening balance and 44 entries). Checked by
`packages/domain/src/ledgerArchive.test.ts` and `packages/data/src/ledgerArchive.test.ts`:

- every row's date, voucher, type, bill, quantity, debit, credit, printed balance and description equal the row
  typed from the rendered pages;
- every running balance follows from the one before;
- every one of the 42 sale rows' own words agree with its figures: dozens × rate − discount = debit (for example
  4 × 7,920 − 1,440 = 30,240);
- opening 202,200 · quantity 79 · debit 452,160 · credit 300,480 · closing 353,880, as printed at the foot of page 2.
