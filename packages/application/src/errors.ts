export class DuplicateQrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateQrError";
  }
}

/** A well-formed QR value that the QR Generator never issued. */
export class UnregisteredQrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnregisteredQrError";
  }
}
