# A bill must keep saying what its gatepass says

**Date:** 2026-09-29
**Status:** Implemented.
**Scope:** Sale Voucher line items on a bill made from a gatepass. No change to pricing, to
discount authority, to dispatch, or to bills that were not made from a gatepass.

---

## The rule

A gatepass is the document the goods physically left on. A bill prices that same dispatch.

So the two documents divide cleanly:

| | Belongs to | Who may change it |
|---|---|---|
| Article, size, **quantity** | **the gatepass** | nobody, on the bill |
| Rate per pair, price type, "less" per pair | **the bill** | the billing desk |

If the quantity on a bill could be edited, the paper and the system would disagree about what
left the building, and nothing downstream could tell which one was right. If a quantity is
genuinely wrong, the **gatepass** was wrong: cancel it and make the right one. The bill then
follows.

## What changed

### The authority: the data layer

`assertBillLineMatchesGatepass` runs before **every** line write on a voucher that has a
gatepass — `addVoucherLineItem`, `updateVoucherLineItem` and `deleteVoucherLineItem`. It
refuses, with a message the desk can act on, when:

| Refusal | When |
|---|---|
| `QUANTITY_DIFFERS` | the right article + size, the wrong dozens — names both figures and the gatepass |
| `LINE_NOT_ON_GATEPASS` | an article + size the gatepass never sent |
| `LINE_ALREADY_ON_BILL` | the same article + size twice (the gatepass carries it once) |
| `LINE_MAY_NOT_BE_REMOVED` | taking a gatepass line off the bill, which would leave the dispatch part-billed |

Nothing is written when a line is refused; the error is thrown before the insert or update.

**What the gatepass demands** is computed by `gatepassBillQuantities`: the gatepass is written
in **cartons per colour**, a bill has one line per **article + size in dozens**, because price
and discount live on the article + size and colour is a store concern that never reaches a
bill. Cartons are summed across colours **first** and converted once, so an odd carton count
(3 cartons = 1.5 dozen) stays exact instead of rounding per colour. This mirrors the fold the
billing screen already does when it drafts the bill (`features/billing/gatepassToVoucher`) —
here it is the authority, so a caller that skips the screen cannot bill something the gatepass
never sent.

Quantities are dozens held as `REAL`, so they are compared within `1e-6` rather than by exact
float equality.

### What the desk sees

On a bill made from a gatepass the Items table now:

* shows **DZN as a figure** with "From GP-000007" under it, instead of a text box;
* has **no remove button** on any row;
* carries one line above the table: *"Quantities come from GP-000007 — Rate, type and less are
  yours to set. If a quantity is wrong, cancel the gatepass and make the right one."*

Rate, price type and "less" are untouched and still fully editable.

The lock is only what the clerk sees. The rule is enforced on the write path, because a
disabled input is not a rule — the same reasoning as everywhere else in this ERP.

### Unaffected

* **A bill with no gatepass** behaves exactly as before: quantities editable, lines removable.
  There is nothing for it to disagree with. (Every bill made through the UI has a gatepass;
  this covers older records and any other path.)
* **Discount authority** is unchanged — `resolveLineDiscount` remains the ceiling on what a
  line may carry, and it is still consulted on every write.
* **Deleting the whole bill** is unchanged, and remains the way to undo a bill that should not
  exist. It releases the gatepass to be billed again.

## Tests

`packages/data/src/billMatchesGatepass.test.ts` — ten cases against the real database, driven
through the real gatepass and scanning use cases:

* the carton-per-colour → dozen-per-article+size fold, including an odd carton count;
* a line at the gatepass quantity is accepted;
* a different quantity is refused, names what the gatepass sent, and writes nothing;
* a saved line's quantity cannot be edited afterwards;
* rate, price type and less **can** still be changed, and changing them never moves the quantity;
* an article the gatepass never sent is refused;
* the same article + size cannot be billed twice — including via a second **colour** of it;
* a gatepass line cannot be removed;
* a bill with no gatepass is unaffected.

`SaleVoucherFormPage.gatepass.test.tsx` gains a case asserting the screen offers no quantity
field and no remove button, while rate and less stay enabled.
