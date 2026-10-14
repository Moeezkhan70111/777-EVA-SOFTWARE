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

/**
 * A registered QR that was voided in QR Management (or replaced by a B carton label). A kind of
 * UnregisteredQrError, so every station that refused it before still refuses it the same way;
 * Receive Production tells the two apart.
 */
export class VoidedQrError extends UnregisteredQrError {
  constructor(message: string) {
    super(message);
    this.name = "VoidedQrError";
  }
}
