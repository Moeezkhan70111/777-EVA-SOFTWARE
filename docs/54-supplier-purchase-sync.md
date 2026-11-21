# 54 — Supplier balances across computers: purchase bills travel

20 Nov 2026. Builds on docs/43 (bills, payments and cash vouchers travel), docs/53 (opening balances) and
docs/37 (leased records).

## What a supplier's balance is made of

| Part | Written by | Where | Travelled before this | Now |
|---|---|---|---|---|
| Opening balance | Ledger > Opening balance, by an administrator | ACCOUNTS holder | yes (PARTY_OPENING_BALANCE) | yes |
| Payments and receipts | Cash Voucher | ACCOUNTS holder | yes (CASH_VOUCHER) | yes |
| **Purchase bills** | Purchase Bill | **any computer** | **no** | **yes, written on the ACCOUNTS holder only** |
| Claims | requested by closing a machine program (store), posted by Accounts | requests on the STORE holder, claims on the ACCOUNTS holder | no | **yes, from local 116 and cloud 039 (docs/55)** |

Supplier Ledger and Supplier Balance are shown only on the ACCOUNTS holder (`features/parties/ledgerVisibility.ts`).

## What was wrong

1. **A bill could be written anywhere, but is counted only where it was written.** The purchase IPC registered
   through Electron's own `ipcMain`, not the lease gate. A bill entered on any computer but the ACCOUNTS holder never
   reached the only screen that shows supplier balances, and nothing said so.
2. **Bills did not travel.** If ACCOUNTS ever moved to another computer, every bill would be missing there.
3. **An edited bill listed its old lines beside its new ones** (`updatePurchaseVoucher`, since the screen was
   written). It marked the old lines deleted, inserted the new, then un-marked the old. The header total counted
   only the new lines, so the supplier balance was right but the bill disagreed with itself. Reproduced on a scratch
   database: a 2 × 100 line edited to 5 × 100 kept both lines (Rs 700) under a Rs 500 total.

## What changed

- **A bill is written on the ACCOUNTS holder** (`main/leaseChannels.ts`): Purchase Bill create, edit and delete are
  leased to ACCOUNTS, like cash vouchers and opening balances. The purchase IPC now registers through the lease gate.
  - Anywhere else the save is refused with the gate's own sentence ("Accounts is written on PC… only. It is
    read-only here."). The Purchase Bill screen and the list's Delete now show that sentence. Before this, the form
    had no `catch`, so a refusal would have looked like nothing happening.
  - A computer that is not synced writes as before.
- **A bill travels as `PURCHASE_VOUCHER`**, a leased record under ACCOUNTS:
  - local **115** (the outbox learns the type) and cloud **038** (registers it);
  - captured by triggers, built whole by revision with its lines, applied by the generic contract;
  - a repeat is a DUPLICATE, so delivery is idempotent;
  - every revision is in the cloud's log, and a deletion travels with who deleted it.
- **The edit fix:** replaced lines stay marked deleted as history; the bill shows only its current lines.

## What a bill does NOT do

A purchase bill writes `purchase_vouchers` and `purchase_voucher_line_items` only. No stock movement, cash, claim,
production or carton figure is written by it, on the computer that writes it or on any computer that receives it.
Only the supplier ledger and balances read it. Raw material arrives by receiving scans and Move In vouchers, which
are separate and unchanged (`features/rawMaterial/ReceiptsTab.tsx`).

## Bills stored before this release are NOT sent

Capture triggers are installed after migrations, so only bills written or changed from this release on are marked.
Older bills stay on the computer that holds them. Sending them needs a backfill, which this work does not run and
which needs the owner's authorisation. Until then:

- the ACCOUNTS holder still has every bill it ever stored, so its supplier balances are complete there;
- other computers receive new bills only, so supplier screens **stay on the ACCOUNTS holder only**
  (ledgerVisibility.ts is unchanged).

Bills entered on any other computer before this release are on that computer only, and are in no balance the
holder shows. Whether any exist must be checked on each computer before release (a count of `purchase_vouchers` with
`origin_device_id` not the holder's). If they do, they must be re-entered on the holder, or moved by a separate,
authorised repair. They are not moved here.

## Claims: SUPERSEDED by docs/55

The owner fixed the computers' roles on 21 Nov 2026. The store now records a claim request when a program closes, and
Accounts prices and posts it on PC1. Both travel. The analysis below is kept as it was written.

## Claims: found, not changed (production workflow)

Claims are posted inside **closing a machine program** (`completeMachineProgramProduction`, the STORE lease, the
store computer). The supplier ledger reads them by joining `machine_programs`, which do not travel (docs/43).

- **If the STORE and ACCOUNTS holders are different computers, posted claims are missing from the supplier balances
  the ACCOUNTS holder shows.** They are deductions from what we owe, so that balance is too high by the claims.
  Which computers hold STORE and ACCOUNTS in production was not read for this work.
- Making claims travel would add a sync side effect to closing a machine program, which is a production workflow.
  The claim's ledger line also names its program, so the record must carry that program number, or programs must
  travel. Per the instruction, this is reported, not implemented.
- **Smallest safe change, for a decision:** a PARTY_CLAIM leased record under STORE, carrying its own program number
  and material name, with the supplier ledger reading those instead of joining the program. Closing a program would
  then mark one claim record per claim in the same transaction. No stock, cash or program figure changes. A reversed
  claim travels as a new revision with its status.

## A bill number typed twice

`purchase_vouchers.voucher_number` is UNIQUE, and a bill number may be typed from the paper book. If a bill arrives
whose number a different local bill already holds (possible only for a bill typed on a non-holder before this
release), the generic contract moves the local one's number aside to `~moved:<id>` and records the original in
`sync_displaced_records`, as for every leased record. It is not lost, but it is renamed.

## Tests

- `packages/sync/src/purchaseVoucherSync.test.ts`, two real databases:
  - the bill arrives after its supplier and material, as one revision;
  - both show the same Supplier Balance and ledger after create, edit and delete;
  - an edited bill has one current line on both, with the replaced line kept;
  - delivery twice changes nothing, and the reader never marks what it received;
  - no stock event, stock balance, carton event, cash voucher or claim is written on either computer;
  - an older, unchanged bill is not sent.
- `apps/desktop/src/main/leaseChannels.test.ts`: purchases registers through the gate; its three writes are under
  ACCOUNTS.
- `apps/desktop/src/renderer/pages/PurchaseVoucherFormPage.test.tsx`: a refused save shows who writes bills.
- The real app, on scratch copies (synthetic data, loopback "cloud"):
  - on the ACCOUNTS holder a bill saved through the real bridge is in the supplier's ledger, and marked to send;
  - with another computer holding ACCOUNTS, the gate refused it and nothing was written.
- **Not done:** a two-computer run against the TEST cloud. The existing TEST rehearsal workspaces (W1–W4) were not to be
  modified, and cloud 038 is not applied to TEST.

## Release order

Apply cloud **038** before the release carrying local **115** reaches the ACCOUNTS holder (until then a bill waits
UNKNOWN_RECORD_TYPE, and nothing else is held up).
