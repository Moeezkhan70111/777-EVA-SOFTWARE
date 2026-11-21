# Legacy ledger fixtures — SYNTHETIC

Six reports in the exact layout of the previous software's (777 EVA Shoes) **Customer Ledger Report** and **Supplier
Ledger Report** `.xls` exports, used by `apps/desktop/.../legacyLedgerImport.test.ts` (docs/53).

**They contain no real business data.** Each was derived from a real export by keeping every cell's position, type,
number format, page break and row kind, and replacing everything else:

- party names (`SYNTHETIC CUSTOMER ALPHA` …) and codes (`1301901` …, `1201901` …, same prefixes as the real ones);
- voucher and bill numbers, moved by a fixed offset, so a number shared between voucher types stays shared;
- descriptions, one synthetic text per distinct original, so legitimately repeated lines stay identical and no new
  repeats appear (`PAID CASH n`, `CLAIM n PAIR`, `MAAL WAPIS n`, `bill no n`, `Total Qty= n`, `Synthetic line n`);
- amounts (× 0.61) and quantities (× 0.8, a half-dozen staying a half-dozen); every running balance and every
  Total line is recomputed, so each report still adds up exactly.

Transaction dates and voucher types are kept, so periods, cutovers and the supplier CV debit/credit split behave as in
the real files. One file's merged-cell layout is capped at 8,000 ranges (SheetJS writes no more); the reader ignores
merges.

The real exports are **not** in this repository and must never be added. The generator that reads them is kept
outside it, with them.

| File | Side | Lines | Pages | Edge cases it carries |
|---|---|---|---|---|
| synthetic-customer-1301901.xls | Customer | 999 | 42 | 5 repeated legitimate lines, half-dozen quantities, SL debits, CV and JV credits |
| synthetic-customer-1301902.xls | Customer | 263 | 11 | half-dozen quantities, no repeated lines |
| synthetic-customer-1301903.xls | Customer | 1,321 | 59 | the largest; 7 repeated lines; merged layout capped as above |
| synthetic-supplier-1201901.xls | Supplier | 154 | 5 | CV both ways: 52 debits (paid, claims, goods back), 12 credits (bills) |
| synthetic-supplier-1201902.xls | Supplier | 43 | 2 | large opening payable, CV debits only |
| synthetic-supplier-1201903.xls | Supplier | 21 | 1 | opens at zero |

In every customer file the description and figures sit one column further right on sale lines than on the others, as
in the real exports. None of the real exports wraps a description onto a second row; that case is covered by the
domain reader tests (`packages/domain/src/legacyLedgerReport.test.ts`).
