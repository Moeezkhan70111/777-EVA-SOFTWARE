// Exporting a table to a spreadsheet, in one place.
//
// The ERP had this written out five times — Current Stock, Production History, Customer
// Ledger, Supplier Ledger and Discount Policy each built their own quoted rows, their own
// Blob and their own <a download>. Each copy quoted slightly differently and none of them
// wrote a byte-order mark, so a material or party name in Urdu opened as mojibake in Excel
// on Windows. This is the single implementation.
//
// "Excel export" in this ERP means a UTF-8 CSV, which Excel opens directly. There is no
// spreadsheet library in the project and adding one to write a flat table would be a large
// dependency for no gain (CLAUDE.md R22). If true .xlsx is ever needed — several sheets,
// formatting, formulas — that is a deliberate dependency decision, not something to slip in
// behind a file extension.

/** Excel on Windows reads a CSV as the system codepage unless the file starts with this. */
const UTF8_BOM = "﻿";

export type CsvValue = string | number | null | undefined;

export interface CsvSheet {
  /** Column headings, in order. */
  headers: string[];
  /** One array per row, in the same order as `headers`. */
  rows: CsvValue[][];
  /** Lines placed above the headings — a title, the filters used, the date. */
  preamble?: string[];
  /** Tab-separated output, for the few places that paste straight into a sheet. */
  delimiter?: "," | "\t";
}

const cell = (value: CsvValue, delimiter: string): string => {
  const text = value == null ? "" : String(value);
  // A quoted field is always safe; quoting everything also stops Excel turning a code like
  // 7/10 into a date.
  return delimiter === "\t" ? text.replace(/[\t\r\n]/g, " ") : `"${text.replace(/"/g, '""')}"`;
};

/** The sheet as CSV text, byte-order mark included. */
export const toCsv = (sheet: CsvSheet): string => {
  const delimiter = sheet.delimiter ?? ",";
  const lines = [
    ...(sheet.preamble ?? []).map((line) => cell(line, delimiter)),
    ...(sheet.preamble?.length ? [""] : []),
    sheet.headers.map((header) => cell(header, delimiter)).join(delimiter),
    ...sheet.rows.map((row) => row.map((value) => cell(value, delimiter)).join(delimiter)),
  ];
  return UTF8_BOM + lines.join("\n");
};

/** Hands the sheet to the operator as a download. `fileName` is used without an extension. */
export const downloadCsv = (fileName: string, sheet: CsvSheet): void => {
  const blob = new Blob([toCsv(sheet)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileName}.csv`;
  link.click();
  URL.revokeObjectURL(url);
};

/** "stock-2026-09-28" — a file name that sorts by date and has nothing to escape. */
export const exportFileName = (prefix: string, now: Date = new Date()): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${prefix}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};
