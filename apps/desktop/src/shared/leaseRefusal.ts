// A write refused because this computer does not hold the domain's lease (docs/37 section W).
//
// Shared by both sides: the main process throws it under this name (leaseGuard.ts), and the renderer
// recognises it by the same name. Electron carries only the message across the process boundary, as
// "Error invoking remote method 'erp:…': LeaseError: <the sentence>", so the name inside that message
// is how the renderer knows a refused write from any other failure.

export const LEASE_ERROR_NAME = "LeaseError";

const MARKER = `${LEASE_ERROR_NAME}: `;

/** The operator's sentence when `error` is a refused leased write -- it names who writes it. Otherwise null. */
export const leaseRefusalText = (error: unknown): string | null => {
  if (!(error instanceof Error)) return null;
  const at = error.message.indexOf(MARKER);
  if (at >= 0) return error.message.slice(at + MARKER.length);
  return error.name === LEASE_ERROR_NAME ? error.message : null;
};
