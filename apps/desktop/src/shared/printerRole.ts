// Which printer a print job is for. A job that names no role goes to the computer's default printer,
// as QR labels always have. The renderer asks by role; only the main process knows printer names.

export const PRINTER_ROLE = {
  /** The store's long-slip printer: Move In receipts and Move Out slips. */
  SLIP: "SLIP",
} as const;

export type PrinterRole = (typeof PRINTER_ROLE)[keyof typeof PRINTER_ROLE];
