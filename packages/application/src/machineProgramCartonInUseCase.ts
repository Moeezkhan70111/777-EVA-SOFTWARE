import { InvalidQrError, isValidRawMaterialQrId, parseQrCode } from "@erp/domain";
import { UnregisteredQrError } from "./errors.js";
import { formatMachineProgramCodeNumber } from "./machineProgramStoreOutUseCases.js";
import { recordProductionInTransaction, type RecordProductionDeps } from "./processScanUseCase.js";
import {
  StoreEntryRejectedError,
  receiveIntoStoreInTransaction,
  type ReceiveIntoStoreDeps,
} from "./storeEntryScanUseCase.js";
import type { EventPublisher, ScanOperationalContext, TransactionContext, TransactionManager } from "./ports.js";

// Store In receiving the cartons a Machine Program sent back.
//
//   MP-000008 · 2 DOZEN of uppers out → 4 carton labels printed → the machine fills them
//   Store In scans each carton label            →   PRODUCED + IN STORE, in one transaction
//
// The carton labels were printed against the program (machine_program_carton_labels), so a
// scan here is judged against the program the operator opened: a carton printed for another
// program, or for none, is refused by name and nothing is written.
//
// Nothing here is a second production or store path. The scan runs the production step and the
// Store Move In step — the very same functions Live Production and Store Move In run — inside
// ONE transaction: the carton is produced and stored in together, or not at all. A carton that
// was already scanned in Live Production is simply stored in.

export interface MachineProgramCartonOrigin {
  programId: string;
  programNumber: number;
  /** Closed (complete or reconciled): its figures are final, so no carton is stored in against it. */
  closed: boolean;
}

export type MachineProgramCartonInOutcome =
  | "RECEIVED"
  | "INVALID_FORMAT"
  /** A raw material label: it belongs to the Scan Material station beside this one. */
  | "RAW_MATERIAL_NOT_SUPPORTED"
  /** A carton QR that was not printed through Machine Move Out. */
  | "NOT_ON_PROGRAM"
  /** A carton printed for a different machine program. */
  | "OTHER_PROGRAM"
  /** The program is closed: its reconciliation is final. */
  | "PROGRAM_CLOSED"
  | "ALREADY_IN_STORE"
  | "NOT_ELIGIBLE"
  /** Voided in QR Management: there is no carton to produce. */
  | "VOIDED"
  | "STATUS_CHANGED";

export interface MachineProgramCartonInInput {
  programId: string;
  rawScan: string;
  context: ScanOperationalContext;
  actor?: string | null;
}

export interface MachineProgramCartonInResult {
  accepted: boolean;
  outcome: MachineProgramCartonInOutcome;
  reason?: string;
  qrId?: string;
  article?: string;
  color?: string;
  size?: string;
  /** True when this scan was also the carton's production scan. */
  producedNow?: boolean;
  receivedAt?: string;
}

export type MachineProgramCartonInDeps = RecordProductionDeps &
  ReceiveIntoStoreDeps & {
    txManager: TransactionManager;
    eventPublisher: EventPublisher;
    cartonOriginRepo: {
      findMachineProgramOfCartonQr(qrId: string, tx: TransactionContext): Promise<MachineProgramCartonOrigin | null>;
    };
  };

/** Thrown inside the transaction when the carton is not this program's. Nothing is written. */
class CartonNotOnProgramError extends Error {
  constructor(readonly outcome: "NOT_ON_PROGRAM" | "OTHER_PROGRAM" | "PROGRAM_CLOSED", message: string) {
    super(message);
    this.name = "CartonNotOnProgramError";
  }
}

/** The scan as a carton identity, or the refusal for anything that is not one. */
const parseCartonScan = (
  rawScan: string
): { parsed: ReturnType<typeof parseQrCode> } | { refusal: MachineProgramCartonInResult } => {
  try {
    return { parsed: parseQrCode(rawScan) };
  } catch (error) {
    if (!(error instanceof InvalidQrError)) throw error;
    if (isValidRawMaterialQrId(rawScan)) {
      return {
        refusal: {
          accepted: false,
          outcome: "RAW_MATERIAL_NOT_SUPPORTED",
          qrId: rawScan.trim().toUpperCase(),
          reason: "This is a raw material QR. Scan it in Scan Material — this box takes the program's cartons.",
        },
      };
    }
    return { refusal: { accepted: false, outcome: "INVALID_FORMAT", reason: "This is not a carton QR. Check the label and scan again." } };
  }
};

/** Refuses the carton unless its label was printed for the program the operator opened. */
const requireCartonOfProgram = async (
  deps: MachineProgramCartonInDeps,
  qrId: string,
  programId: string,
  tx: TransactionContext
): Promise<void> => {
  const origin = await deps.cartonOriginRepo.findMachineProgramOfCartonQr(qrId, tx);
  if (!origin) {
    throw new CartonNotOnProgramError(
      "NOT_ON_PROGRAM",
      "This carton was not printed for a machine program. Receive it on Store Move In."
    );
  }
  if (origin.programId !== programId) {
    const code = formatMachineProgramCodeNumber(origin.programNumber);
    throw new CartonNotOnProgramError("OTHER_PROGRAM", `This carton was printed for ${code}. Open ${code} to receive it.`);
  }
  if (origin.closed) {
    const code = formatMachineProgramCodeNumber(origin.programNumber);
    throw new CartonNotOnProgramError("PROGRAM_CLOSED", `${code} is closed — its cartons are reconciled, so this one cannot be stored in against it.`);
  }
};

export class ReceiveMachineProgramCartonUseCase {
  constructor(private readonly deps: MachineProgramCartonInDeps) {}

  async execute(input: MachineProgramCartonInInput): Promise<MachineProgramCartonInResult> {
    const scan = parseCartonScan(input.rawScan);
    if ("refusal" in scan) return scan.refusal;
    const { parsed } = scan;
    const { qrId } = parsed.payload;

    try {
      const committed = await this.deps.txManager.runInTransaction(async (tx) => {
        await requireCartonOfProgram(this.deps, qrId, input.programId, tx);
        // Produced already (Live Production got there first) → only the store-in is left.
        const producedNow = !(await this.deps.duplicateChecker.existsByQrId(qrId, tx));
        if (producedNow) await recordProductionInTransaction(this.deps, { parsed, context: input.context }, tx);
        const stored = await receiveIntoStoreInTransaction(this.deps, { parsed, context: input.context, actor: input.actor }, tx);
        return { producedNow, stored };
      });

      await this.publish(parsed, committed.producedNow, committed.stored.receivedAt);
      return {
        accepted: true,
        outcome: "RECEIVED",
        qrId,
        article: committed.stored.identity.article,
        color: committed.stored.identity.color,
        size: committed.stored.identity.size,
        producedNow: committed.producedNow,
        receivedAt: committed.stored.receivedAt,
      };
    } catch (error) {
      return refusalOf(error, parsed);
    }
  }

  private async publish(parsed: ReturnType<typeof parseQrCode>, producedNow: boolean, occurredAt: string): Promise<void> {
    const event = { qrId: parsed.payload.qrId, parserVersion: parsed.parserVersion, occurredAt };
    if (producedNow) await this.deps.eventPublisher.publish("ProductionCompleted.v1", event);
    await this.deps.eventPublisher.publish("StoreEntryCompleted.v1", event);
  }
}

/** A refusal thrown inside the transaction, as the result the screen reads. Anything else is a fault. */
const refusalOf = (error: unknown, parsed: ReturnType<typeof parseQrCode>): MachineProgramCartonInResult => {
  const identity = { qrId: parsed.payload.qrId, article: parsed.payload.article, color: parsed.payload.color, size: parsed.payload.size };
  if (error instanceof CartonNotOnProgramError) return { accepted: false, outcome: error.outcome, reason: error.message, ...identity };
  if (error instanceof UnregisteredQrError) return { accepted: false, outcome: "VOIDED", reason: error.message, ...identity };
  if (error instanceof StoreEntryRejectedError) {
    const outcome = error.outcome === "ALREADY_IN_STORE" || error.outcome === "STATUS_CHANGED" ? error.outcome : "NOT_ELIGIBLE";
    return { accepted: false, outcome, reason: error.message, ...identity };
  }
  throw error;
};
