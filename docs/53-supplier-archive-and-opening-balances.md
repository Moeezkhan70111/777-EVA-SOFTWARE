# 53 — Supplier ledger archive, opening balances and reconciliation

Owner's request, 19 Nov 2026: the second phase of [50](50-historical-ledger-archive.md).

1. Archive **suppliers'** old ledgers as well as customers'.
2. Carry each customer's and supplier's verified closing balance from the old software into the live ERP as its
   **opening balance**, so the ERP's Current Balance is the real balance.
3. **Reconcile** the two, so any difference is obvious.

**Uncommitted. Not released. Cloud 034 and 037 not applied.** See "Before it can be used" at the end.

## The accounting treatment

The ERP has no general ledger and no chart of accounts. A party's balance is a sum over its own documents:

| Ledger | Positive means | Debit | Credit |
|---|---|---|---|
| Customer (`database/cash.ts`, `sales.ts`) | receivable: the customer owes us | sale, cash payment to them | cash receipt, sale return |
| Supplier (`database/purchases.ts`) | payable: we owe the supplier | payment, receipt, claim | purchase |

The two conventions are opposite. Both were verified in the code, not assumed.

An **opening balance** is one more figure in that sum. It lives in a table of its own (`party_opening_balances`) and
stores a **direction** and a positive amount, never a bare sign:

| Party | DEBIT | CREDIT |
|---|---|---|
| Customer | receivable: added to what they owe | an advance: subtracted |
| Supplier | we paid ahead: subtracted from what we owe | payable: added |

In double entry its other side is opening-balance equity, which the ERP does not hold. So it creates **no sale,
purchase, cash voucher, receipt, payment, stock movement or report figure**. It moves the party's balance and nothing
else. `partyOpeningBalances.test.ts` checks this directly: every other table's row count, and the archive, are
identical before and after posting, reversing and posting again.

**One SQL fragment**, `openingBalancePaisaSql` (`database/partyOpeningBalances.ts`), is how every live balance learns
about opening balances:

- `getCurrentPartyBalance` (the balance-limit check, and the Cash Voucher screen's balance)
- `listCustomerBalances` (also returns `openingBalance`, dated: only one in effect by the as-of date)
- `getCustomerLedgerWithCash`: before the range it is part of the Opening Balance figure. Inside the range it is a row
  `OB · Opening balance`, first on its day.
- `getSupplierLedger` and `listSupplierBalances`, the same way, credit-positive.

**Archived rows never contribute.** Nothing that works out a balance reads the archive tables.

**Effect on balance limits.** Once a customer's opening balance is posted, the balance-limit check counts it. A
customer whose old outstanding is near their limit will be stopped from new bills, which is the true position. Check
limits before posting.

### Never overwritten

- **One per party.** `party_opening_balances.party_id` is UNIQUE.
- **Posted once.** A second posting is refused while one stands: "Correct or reverse it instead."
- **Reversal** needs a reason and takes it out of the live balance. **Correction** is a reversal plus a new posting
  in one transaction, with a reason.
- **History.** Every step is a row in `party_opening_balance_entries`: what (direction, amount, date, source, optional
  archived statement), who, when, why. Rows are never changed. The application has no way to update a posted amount.
- **Version check.** A reversal or correction names the version the person saw. If someone else changed it first,
  it is refused.
- **Retry-safe.** Each write carries a request id. A retry after a lost answer is answered, not repeated.
- **Audit.** Each step also writes this computer's `audit_log` (`PARTY_OPENING_BALANCE_POSTED`, `_CORRECTED`,
  `_REVERSED`). An archive import writes `LEDGER_ARCHIVE_IMPORTED`.
- **Who.** Administrators only (`requireAdmin`), on the computer holding the ACCOUNTS lease (where cash vouchers are
  written). No existing user's permissions change. Reading needs Customer Ledger or Supplier Ledger access for that
  party's side.

### A warning the screen gives

If live documents are dated **before** an opening balance takes effect, the strip says so. The old closing balance
may already include them, and they would be counted twice. The ERP does not decide this; the person checks the cutover.

## Supplier archives

The import from 50 now names a side, CUSTOMER or SUPPLIER: the ledger screen it is opened from.

- A supplier statement is matched **only to suppliers**. A customer's statement only to customers. The wrong type is
  refused ("… is not a supplier").
- The CSV is the same template. `supplier_name`, `supplier`, `supplier_code` are accepted as headings.
- **Which way its balance ran is read from the rows, not assumed.** A supplier statement is checked as credit less
  debit (what we owe). If its rows do not follow that but do follow debit less credit (old software printing "80,000
  Cr" / "5,000 Dr"), it is accepted that way with a warning. A row that follows neither rule is refused with the
  figures. The rule found is stored with the statement (`balance_rule`). A customer statement is always debit less
  credit, as before.
- The same duplicate protection: the same file, the same statement, or any row already archived for that party.
- The Supplier Ledger screen now shows archived rows in its own table, by date, marked **Archived**. It also has the
  Archived filter, search, separate live and archived totals, the Previous software strip, Download Excel and PDF, and
  Import old ledger for accounts users.

Fixture: `docs/fixtures/ledger-archive/test-suppliers.csv`. It is synthetic ("Test Supplier …"), with one supplier
printed credit less debit and one printed with Cr / Dr.

## Reconciliation

**Reconciliation** on both ledger screens lists every party with an archive or an opening balance:

| Party | Old code | Statements | Archive opening | Debit | Credit | Archive closing | Opening balance | Difference | Live balance | Status |
|---|---|---|---|---|---|---|---|---|---|---|

- **Figures are in the ledger's own convention.** Positive is receivable for a customer, payable for a supplier. A
  supplier statement printed debit less credit is turned the right way round.
- **The archive is checked again from its stored rows**: every running balance follows from the one before, each
  statement's opening + debits − credits = closing, and consecutive statements join up.
- **Status**: ✓ Matched · ⚠ Different (with the difference) · ⚠ No opening balance · • No archive · ✕ Archive does
  not add up. A note is added when the archive runs on or past the opening balance's date.
- Nothing is adjusted to make figures agree. Download Excel gives the same table.

Behraam Shoes Karachi (1301139): archive opening 202,200, debit 452,160, credit 300,480, closing 353,880, every row
following. Posting 353,880 DEBIT gives **Matched**, difference 0, live balance 353,880.

## Migrations

| | Local | Cloud |
|---|---|---|
| Archive (50) | 111 | 034 (prepared, not applied) |
| Parties lease (51) | none | 035 (prepared, not applied) |
| Pending Orders ([52](52-pending-orders.md)) | 112 | 036 (prepared, not applied) |
| **This** | **113** `113_party_opening_balances` | **037** `037_party_opening_balance_records` (prepared, not applied) |

- **Local 113.**
  - Adds `ledger_side` and `balance_rule` to `ledger_archive_statements`. Defaults are CUSTOMER and
    DEBIT_LESS_CREDIT, so every statement imported under 111 reads as before.
  - Creates `party_opening_balances` and `party_opening_balance_entries`.
  - Rebuilds the outbox CHECK to allow `PARTY_OPENING_BALANCE`. The rebuild also allows Pending Orders' two types, so
    it cannot drop them.
  - Its down file refuses while any supplier statement or any opening balance exists, and keeps Pending Orders'
    types allowed.
- **112 and 113 in either order.** 112's outbox rebuild (and its down file) also allows `PARTY_OPENING_BALANCE`, so a
  computer that meets 113 before 112 keeps it. Before this was added (merge, 19 Nov), that order dropped the type, or
  refused to start with an opening balance still queued. Every order is now tested on scratch databases.
- **Cloud 037** registers `PARTY_OPENING_BALANCE` as a leased record under ACCOUNTS. Rows only, like 034. It needs 034,
  because an opening balance may name the archived statement it was checked against. Until 034 and 037 are applied, a
  statement or an opening balance waits in the outbox as UNKNOWN_RECORD_TYPE, and nothing else is held up.
- **Sync.** One record per party: its position and its whole history travel as one revision. A correction arrives
  as one revision, so no computer ever holds two opening balances for one party. `partyOpeningBalanceSync.test.ts`
  checks this end to end: an archive and an opening balance are imported, posted, corrected, re-delivered and
  reversed on one computer and applied on another. The balances agree after every step, re-delivery changes nothing,
  and the reader never marks what it received as its own.
- Supplier archives travel as the same `LEDGER_ARCHIVE_STATEMENT` record. No new cloud type.

## Known limits

- **Purchase vouchers and party claims do not replicate** (they are not leased records, and Purchase Bill is not
  lease-gated: any computer can enter one). A supplier's opening balance and archive reach every computer, but its
  purchases stay on the computer they were entered on. The existing app already allows for this:
  `features/parties/ledgerVisibility.ts` shows Supplier Ledger and Supplier Balance **only on the computer holding the
  ACCOUNTS lease**, so a supplier balance is shown only where opening balances, cash vouchers and (by practice) purchase
  bills are. The figure is right only if purchase bills are entered on that computer. That is an operating rule, not
  something the app enforces.
- The Cash Voucher screen fetches each line's party balance with `getCurrentPartyBalance` (the customer formula, as
  before this work), but the column that showed it is hidden (`.cash-party-table-legacy { display: none }`), and the
  visible party table shows no balance. Nothing wrong is on screen. If that column is ever shown again, it must use
  the supplier formula for suppliers.
- `getCustomerLedger` (`sales.ts`, the older ledger, not used by any screen) does not include opening balances. It
  starts its running balance at zero for the range and is not a balance of record.
- The form uses the project's existing state-based form pattern with the domain's own validation. React Hook Form and
  Zod (R17) are not installed in this project, and were not added for one form.
- Contractors' ledgers are not covered.

## Before it can be used

1. Review and commit this work. It shares the worktree with the uncommitted parties-lease work (51), which must be
   sorted out first.
2. Apply cloud **034** and then **037** to TEST, verify, then production (owner's authorisation).
3. Build and release. Run it once on a copy of the accounts computer's database: import Behraam, post its opening
   balance, open both ledgers and the reconciliation.
4. On the accounts computer: import the old ledgers (customers, then suppliers), post each opening balance (an
   administrator), and check the reconciliation shows ✓ Matched for every party before relying on the balances.
