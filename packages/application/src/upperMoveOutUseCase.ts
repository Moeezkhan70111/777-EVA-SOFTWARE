import {
  RAW_MATERIAL_KIND,
  RAW_MATERIAL_QR_STATUS,
  UPPER_ISSUE_OUTCOME,
  isValidQrCode,
  isValidRawMaterialQrId,
  type UpperIssueOutcome,
} from "@erp/domain";
import type { ScanOperationalContext, TransactionContext } from "./ports.js";
import {
  RawMaterialIssueRejectedError,
  checkRawMaterialScanFormat,
  issueRawMaterialPacket,
  type RawMaterialIssueDeps,
} from "./rawMaterialIssueUseCase.js";
import type { RawMaterialMovementRepository } from "./rawMaterialReceiptUseCase.js";

// UPPER MOVE OUT — one upper packet issued out of the store to a named machine (Phase 3).
//
//   scan / typed code + machine
//     ─► no machine?                   MACHINE_REQUIRED     (nothing read, nothing written)
//     ─► a finished-goods carton QR?   FINISHED_CARTON
//     ─► not a raw material QR?        INVALID_QR
//     ─► one write transaction:
//          machine unknown / retired?  MACHINE_INELIGIBLE
//          never generated?            UNKNOWN_QR
//          not an UPPER material?      NOT_UPPER
//          already issued?             ALREADY_ISSUED
//          not in the store / voided … NOT_IN_STORE / INELIGIBLE / NOT_CONFIGURED
//          otherwise                   issueRawMaterialPacket, MACHINE binding:
//                                      IN_STORE → ISSUED (guarded), stock debited (never below zero),
//                                      STORE_EXIT stamped with the machine and the issue session
//
// The packet leaves the store through issueRawMaterialPacket — the ONE place any raw material
// packet does — so the status move, the stock debit and the event commit together or not at all,
// and the guarded status move is what makes a second issue of the same packet impossible. Issues
// are run one at a time through this instance (see ReceiveProductionUseCase for why the shared
// transaction manager needs that).

/** The repository Upper Move Out reads, beside what every packet movement reads. */
export interface UpperMoveOutRepository extends RawMaterialMovementRepository {
  /** The machine an upper is issued to, as the database holds it — never as the screen says. */
  getMachineForIssue(machineId: string, tx: TransactionContext): { id: string; name: string; status: string } | null;
}

export interface UpperMoveOutDeps extends Omit<RawMaterialIssueDeps, "repo"> {
  repo: UpperMoveOutRepository;
}

export interface UpperMoveOutInput {
  rawScan: string;
  machineId: string;
  /** The device's open Raw Material Output issue session — the existing session, reused. */
  sessionId: string | null;
  context: ScanOperationalContext;
  actor: string;
}

export interface UpperMoveOutResult {
  accepted: boolean;
  outcome: UpperIssueOutcome;
  qrId?: string;
  reason?: string;
  /** The STORE_EXIT event that recorded the issue. */
  eventId?: string;
}

class UpperRefusal extends Error {
  constructor(readonly outcome: UpperIssueOutcome, message: string) {
    super(message);
  }
}

/** The refusals the shared issue step throws, in this screen's words. */
const PACKET_REFUSAL: Partial<Record<string, UpperIssueOutcome>> = {
  UNKNOWN_QR: UPPER_ISSUE_OUTCOME.UNKNOWN_QR,
  NOT_IN_STORE: UPPER_ISSUE_OUTCOME.NOT_IN_STORE,
  NOT_ELIGIBLE: UPPER_ISSUE_OUTCOME.INELIGIBLE,
  NOT_CONFIGURED: UPPER_ISSUE_OUTCOME.NOT_CONFIGURED,
  STATUS_CHANGED: UPPER_ISSUE_OUTCOME.CONCURRENT_ISSUE,
};

const refused = (outcome: UpperIssueOutcome, reason: string, qrId?: string): UpperMoveOutResult => ({ accepted: false, outcome, reason, qrId });

/** Format checks made before any transaction: what the operator scanned may not be a raw material label at all. */
const scanProblem = (raw: string, machineId: string): UpperMoveOutResult | null => {
  if (!machineId) return refused(UPPER_ISSUE_OUTCOME.MACHINE_REQUIRED, "Choose a machine before issuing upper cartons.");
  if (!raw) return refused(UPPER_ISSUE_OUTCOME.INVALID_QR, "Nothing was scanned.");
  if (!isValidRawMaterialQrId(raw) && isValidQrCode(raw)) {
    return refused(UPPER_ISSUE_OUTCOME.FINISHED_CARTON, "This is a finished carton QR, not an upper. Cartons are received on Receive Production.", raw);
  }
  if (checkRawMaterialScanFormat(raw)) return refused(UPPER_ISSUE_OUTCOME.INVALID_QR, "This is not an upper QR. Check the label or what was typed.");
  return null;
};

export class UpperMoveOutUseCase {
  /** The issues still to run, one after another. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: UpperMoveOutDeps) {}

  execute(input: UpperMoveOutInput): Promise<UpperMoveOutResult> {
    const run = this.queue.then(() => this.issue(input));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async issue(input: UpperMoveOutInput): Promise<UpperMoveOutResult> {
    const raw = String(input.rawScan ?? "").trim().toUpperCase();
    const machineId = String(input.machineId ?? "").trim();
    const problem = scanProblem(raw, machineId);
    if (problem) return problem;

    try {
      const eventId = await this.deps.txManager.runInTransaction(async (tx) => {
        this.checkMachine(machineId, tx);
        this.checkPacket(raw, tx);
        const issued = await issueRawMaterialPacket(
          this.deps,
          { qrId: raw, sessionId: input.sessionId, context: input.context, actor: input.actor || null, binding: { mode: "MACHINE", machineId } },
          tx
        );
        return issued.eventId;
      });
      await this.deps.eventPublisher.publish("UpperIssuedToMachine.v1", { qrId: raw, machineId, eventId, occurredAt: new Date().toISOString() });
      return { accepted: true, outcome: UPPER_ISSUE_OUTCOME.ISSUED, qrId: raw, eventId };
    } catch (error) {
      if (error instanceof UpperRefusal) return refused(error.outcome, error.message, raw);
      if (error instanceof RawMaterialIssueRejectedError) {
        return refused(PACKET_REFUSAL[error.outcome] ?? UPPER_ISSUE_OUTCOME.INELIGIBLE, error.message, raw);
      }
      // The stock balance refuses to go below zero (applyRawMaterialStockChange).
      if (error instanceof Error && /would go negative/i.test(error.message)) {
        return refused(UPPER_ISSUE_OUTCOME.INSUFFICIENT_STOCK, "There is not enough of this upper in stock to issue this packet.", raw);
      }
      throw error;
    }
  }

  /** The machine must exist and be in service — checked here, inside the write lock. */
  private checkMachine(machineId: string, tx: TransactionContext): void {
    const machine = this.deps.repo.getMachineForIssue(machineId, tx);
    if (!machine) throw new UpperRefusal(UPPER_ISSUE_OUTCOME.MACHINE_INELIGIBLE, "That machine is no longer set up. Choose another machine.");
    if (machine.status !== "ACTIVE") throw new UpperRefusal(UPPER_ISSUE_OUTCOME.MACHINE_INELIGIBLE, `${machine.name} is retired. Choose another machine.`);
  }

  /** Only an upper, and not one already issued — the rest is the shared issue step's to judge. */
  private checkPacket(qrId: string, tx: TransactionContext): void {
    const unit = this.deps.repo.getRawMaterialQrForMovement(qrId, tx);
    if (!unit) throw new UpperRefusal(UPPER_ISSUE_OUTCOME.UNKNOWN_QR, "This QR was never generated, so there is no packet to issue.");
    if (unit.kind !== RAW_MATERIAL_KIND.UPPER) {
      throw new UpperRefusal(UPPER_ISSUE_OUTCOME.NOT_UPPER, `${unit.displayName} is not an upper. Issue it on Raw Material Output.`);
    }
    if (unit.registryStatus !== "VOID" && unit.currentStatus === RAW_MATERIAL_QR_STATUS.ISSUED) {
      throw new UpperRefusal(UPPER_ISSUE_OUTCOME.ALREADY_ISSUED, "This upper packet has already been issued out of the store.");
    }
  }
}
