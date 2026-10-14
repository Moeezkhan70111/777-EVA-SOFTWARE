import {
  InvalidQrError,
  RECEIVE_PRODUCTION_OUTCOME,
  RECEIVE_PRODUCTION_STATION,
  isValidRawMaterialQrId,
  parseQrCode,
  type ReceiveProductionOutcome,
} from "@erp/domain";
import { DuplicateQrError, UnregisteredQrError, VoidedQrError } from "./errors.js";
import type { ScanOperationalContext } from "./ports.js";
import { recordProductionInTransaction, type ProcessScanDeps } from "./processScanUseCase.js";

// RECEIVE PRODUCTION — one scanned carton QR recorded as produced, exactly once (Phase 2).
//
//   scan / typed code ─► raw material label?   RAW_MATERIAL_QR   (nothing written)
//                     ─► not a carton QR?      INVALID_QR
//                     ─► one write transaction:
//                          already produced?   ALREADY_RECEIVED
//                          never generated?    NOT_GENERATED     (never adopted — unlike Live Production)
//                          voided?             INELIGIBLE
//                          otherwise           RECEIVED: qr_master + PRODUCED event + stock + outbox
//
// The production step is recordProductionInTransaction, the ONE place a carton QR becomes a live
// unit — the same step Live Production and Store In's Carton In use — called WITHOUT
// registerIfUnknown, so an identity the QR Generator never issued is refused, not registered.
//
// Exactly once: the eligibility read and the write happen inside one BEGIN IMMEDIATE, and
// qr_master.qr_id is the PRIMARY KEY, so a second receipt of the same carton cannot be written by
// any route. Receipts are also run one at a time through this instance: two scans arriving
// together are judged in turn, never inside each other's transaction.

export interface ReceiveProductionInput {
  rawScan: string;
  context: ScanOperationalContext;
  /** The signed-in user, recorded on the PRODUCED event as who received the carton. */
  actor: string;
}

export interface ReceiveProductionResult {
  accepted: boolean;
  outcome: ReceiveProductionOutcome;
  /** The canonical carton identity, once the scan could be read as one. */
  qrId?: string;
  reason?: string;
}

const refused = (outcome: ReceiveProductionOutcome, reason: string, qrId?: string): ReceiveProductionResult => ({
  accepted: false,
  outcome,
  reason,
  qrId,
});

/** A primary-key collision on qr_master is a carton produced by someone else first. */
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed: qr_master/i.test(error.message);

export class ReceiveProductionUseCase {
  /** The receipts still to run, one after another (see the note above). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ProcessScanDeps) {}

  execute(input: ReceiveProductionInput): Promise<ReceiveProductionResult> {
    const run = this.queue.then(() => this.receive(input));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async receive(input: ReceiveProductionInput): Promise<ReceiveProductionResult> {
    const raw = String(input.rawScan ?? "").trim().toUpperCase();
    if (!raw) return refused(RECEIVE_PRODUCTION_OUTCOME.INVALID_QR, "Nothing was scanned.");
    if (isValidRawMaterialQrId(raw)) {
      return refused(RECEIVE_PRODUCTION_OUTCOME.RAW_MATERIAL_QR, "This is a raw material label, not a carton QR.", raw);
    }

    let parsed: ReturnType<typeof parseQrCode>;
    try {
      parsed = parseQrCode(raw);
    } catch (error) {
      if (error instanceof InvalidQrError) return refused(RECEIVE_PRODUCTION_OUTCOME.INVALID_QR, error.message);
      throw error;
    }
    const qrId = parsed.payload.qrId;

    try {
      await this.deps.txManager.runInTransaction((tx) =>
        recordProductionInTransaction(
          this.deps,
          { parsed, context: input.context, receivedBy: { actor: input.actor || null, station: RECEIVE_PRODUCTION_STATION } },
          tx
        )
      );
    } catch (error) {
      if (error instanceof DuplicateQrError || isUniqueViolation(error)) {
        return refused(RECEIVE_PRODUCTION_OUTCOME.ALREADY_RECEIVED, "This carton has already been recorded in production.", qrId);
      }
      if (error instanceof VoidedQrError) return refused(RECEIVE_PRODUCTION_OUTCOME.INELIGIBLE, error.message, qrId);
      // A registered code whose product is no longer in the Product Master (legacy identities).
      if (error instanceof Error && error.message.startsWith("PRODUCT_NOT_FOUND:")) {
        return refused(RECEIVE_PRODUCTION_OUTCOME.INELIGIBLE, error.message.replace("PRODUCT_NOT_FOUND:", "").trim(), qrId);
      }
      if (error instanceof UnregisteredQrError) {
        return refused(RECEIVE_PRODUCTION_OUTCOME.NOT_GENERATED, "This QR was never generated, so this carton cannot be received.", qrId);
      }
      throw error;
    }

    await this.deps.eventPublisher.publish("ProductionCompleted.v1", {
      qrId,
      parserVersion: parsed.parserVersion,
      occurredAt: new Date().toISOString(),
    });
    return { accepted: true, outcome: RECEIVE_PRODUCTION_OUTCOME.RECEIVED, qrId };
  }
}
