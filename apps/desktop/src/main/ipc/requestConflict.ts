// A press of Save whose request id already made a DIFFERENT document (migration 105): how a handler answers it.
//
// Read by its code, like the other typed refusals here, so it survives being thrown across module copies.

export interface RequestConflictAnswer {
  accepted: false;
  errorCode: "REQUEST_CONFLICT";
  reason: string;
  existingId: string;
  existingNumber: string;
}

/** The refusal to return for a request conflict, or null when the error is something else. */
export function requestConflictAnswer(error: unknown): RequestConflictAnswer | null {
  if (!(error instanceof Error)) return null;
  const coded = error as Error & { code?: unknown; existing?: { id?: unknown; number?: unknown } };
  if (coded.code !== "REQUEST_CONFLICT") return null;
  return {
    accepted: false,
    errorCode: "REQUEST_CONFLICT",
    reason: error.message,
    existingId: String(coded.existing?.id ?? ""),
    existingNumber: String(coded.existing?.number ?? ""),
  };
}
