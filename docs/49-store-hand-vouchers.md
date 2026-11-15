# 49 — Store hand vouchers (Store → Move in / Move out → By hand)

Owner's request, 15 Nov 2026: "In store move in by hand, make it so the user can enter multiple items at once. Make it a
voucher system: the user makes a voucher of the things that came and prints the slip, can edit or delete that voucher,
and can move between vouchers by number or with Previous / Next." Then the same day: "make for store move out one too."

Owner decisions, 15 Nov 2026:
- the vouchers sync to the cloud;
- a voucher may be edited or deleted **on its own day only**;
- a Move Out voucher names **who it goes to** (supplier or contractor, as Scan Out does) **and what it is for**.

## One voucher, two directions

| | Move In (Store → Move in → By hand) | Move Out (Store → Move out → By hand) |
|---|---|---|
| Number | `SIV-` (its own series) | `SOV-` (its own series) |
| Party | Supplier | Supplier or contractor ("Moving out to") |
| Note | Reference, optional | What for, **required** |
| Each line | a hand move IN (`RECEIVE`) | a hand move OUT (`TRANSFER_OUT`), at most what is in the store, refused while labelled packets of it are in the store |
| Slip | Raw Material Received | Raw Material Issued |

Both directions use the same panel (`features/store/handVoucher/HandVoucherPanel`), the same data module
(`database/handVouchers.ts`) and the same record type. The old one-material Move Out by Hand panel
(`HandMovePanel`) is no longer shown on the Store page.

## The screen

Behind **Store Scanning**, like every other store write, and written on the computer holding the
**RAW_MATERIAL_STORE** lease (PC2). Any other computer opens it read-only: it reads and prints vouchers, and writes none.

```
◄ Previous  [ SOV- 100007  of 100009 ]  Load  Next ►        [ + New voucher ]

Moving out to  [ ASLAM ▾ ]  CONTRACTOR                         Date  15 Nov 2026
1  [ NAWAAR 5 SOOTAR BLACK ▾ ]  [ 700 ]  [ INCH ▾ ]   In store 1950 INCH    ✕
2  [ Choose a raw material ▾ ]                                  (always one empty line for the next material)
What for * [ cutting table ]                                                        [ Save voucher ]
```

- **One party per voucher.** Each **line** is a material, a quantity, and the unit it was measured in: any rung of
  that material's own ladder. "= 2925 INCH" shows what a different unit comes to. Moving out, the line also shows
  "In store …" and says when a figure is more than the store holds.
- A material may appear **once** per voucher. Empty lines are left out.
- **Save voucher** sends every line in one call. The screen's id for the voucher makes a Save retried after a lost
  answer the same voucher.
- A stored voucher shows its lines, who wrote it (and edited or deleted it), its note, and **Print slip**, **Edit**
  and **Delete** while it is today's. An earlier day's voucher is read-only.
- The pager is the shared `DocumentNavigator` (the Gatepass pager, promoted). Each computer numbers from its own
  block (100,000 on PC2), so Previous and Next go to the stored neighbours of the same direction, never to "number − 1".

## The data (local migration 110, `database/handVouchers.ts`)

- `store_hand_vouchers`: direction, number (unique per direction, number sites `storeInVoucher` and
  `storeOutVoucher`), business day (Asia/Karachi), party, note (required moving out, by a CHECK too), status
  `POSTED` or `DELETED`, revision, and who and when for each change.
- `store_hand_voucher_lines`: material, what was typed (quantity and unit), what it came to in the stock unit, and the
  stock movement it made (`stock_event_id`).

**Every line is a hand move**, checked and written by `rawMaterialHandMove.ts` (`checkHandMove`,
`applyCheckedHandMove`). The unit ladder, the retired-material rule, the supplier rule, the labelled-packet rule and
the in-store cap are decided in one place. Moving out, the voucher's party is stamped on each movement, so the daily
report says who it went to. Notes read `Manual move in — 3 RULE · SIV-100012 · Bilty 42` and
`Manual move out — 700 INCH · SOV-100007 · cutting table`, so the daily report shows them as **By hand**.

**Nothing is rewritten.** An **edit** reverses every old line, checks and moves the new lines, replaces the voucher's
lines and adds one to its revision, all in one transaction. The old lines are reversed **first**, so a Move Out line
raised from 60 to 90 KG needs only 30 more in the store; the screen allows the same. A **delete** reverses every line
and marks the voucher `DELETED`. It keeps its number and its lines, and the number is never reused.

| Reversal of | Movement | Note |
|---|---|---|
| a Move In line | `RECEIVE`, negative | `Manual move in — reversed 3 RULE · SIV-100012 edited` |
| a Move Out line | `TRANSFER_IN`, positive | `Manual move out — reversed 700 INCH · SOV-100007 deleted` |

The daily report counts each reversal against its own side (`stockEventReportDirection`, `stockEventReportQuantity`):
a deleted Move Out voucher nets to nothing on Move Out and adds nothing to Move In.

**Refused, with nothing written:**
- a voucher with no lines, a line the hand move refuses, or a material entered twice;
- a Move Out voucher with no "what for", or to a party that is not a supplier or contractor;
- an edit or delete of a voucher from an earlier day, or one already deleted;
- an edit or delete from an out-of-date screen (the revision it was opened at is not the current one);
- an edit or delete that would take back material **already gone out**: when a material's balance falls, what is
  left must not go below zero or below what its labelled packets in the store hold.

An edit that changes nothing writes nothing.

## Sync (cloud migration 033)

The voucher travels as the leased record **STORE_HAND_VOUCHER** under **RAW_MATERIAL_STORE**. An edit or delete sends
a new revision, and the receiver replaces the lines. The stock itself travels as before: each line and each reversal
is its own `STOCK_EVENT`.

**Apply cloud 033 to production before the release carrying local 110 reaches PC2.** Until then a voucher waits as
`UNKNOWN_RECORD_TYPE` (nothing else is held up, and the stock still travels), and PC3 does not see voucher numbers.

## The slip

The store's own slip (`storeVoucher.ts`, Star TSP800II, window fallback), as a **typed** voucher: its number under
"Voucher", the time it was written, each line as typed, the total, and the reference or what it was for. There is no
packets column.
