// One pass of the outbox: claim what is due, offer it, record what happened.
//
// The order matters and is the whole design:
//
//   reclaim abandoned  →  claim a batch  →  send  →  settle each row
//
// Claiming before sending is what makes an interruption survivable. Settling after the answer is
// what makes a lost answer safe: the row stays IN_FLIGHT, is reclaimed, and is offered again —
// and the receiver recognises the repeat.
//
// `runOnce` never throws. A computer whose network is down must keep working, so a failure is a
// set of counts to report, not an exception to propagate into the application.

import crypto from "node:crypto";
import {
  DEFAULT_RETRY_POLICY,
  leaseBatch,
  markFailed,
  markSynced,
  outboxCounts,
  reclaimStale,
  type OutboxCounts,
  type OutboxRetryPolicy,
} from "./outboxQueue.js";
import { SyncTransportError, type SyncTransport } from "./transport.js";
import type { SyncSqlHandle } from "./sqlPort.js";

/**
 * One event the service gave a verdict on, named so an operator can be told WHICH event and WHY.
 *
 * Until this existed the reason reached `sync_outbox.last_error` and stopped there: the pass
 * reported "sent 0" and the panel could not tell a refusal from having nothing to send. A refused
 * push that looks like a quiet success is the exact failure the status indicator exists to
 * prevent, so the verdict now travels back with the result.
 */
export interface OutboxRefusal {
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** The service's own reason, already scrubbed by the transport. */
  readonly reason: string;
  /** True when this refusal spent the last attempt and the event is now parked. */
  readonly parked: boolean;
}

export interface DrainResult {
  readonly reclaimed: number;
  readonly leased: number;
  readonly synced: number;
  readonly failed: number;
  readonly deadLettered: number;
  /** Set when the batch did not reach the service at all. */
  readonly transportError?: string;
  /**
   * Events the service REFUSED this pass, with reasons. Empty on a transport failure: a batch
   * that may never have arrived is not a verdict on anything in it.
   */
  readonly refusals: ReadonlyArray<OutboxRefusal>;
  readonly counts: OutboxCounts;
}

export interface OutboxDrainOptions {
  readonly deviceId: string;
  readonly batchSize?: number;
  readonly retryPolicy?: OutboxRetryPolicy;
  /** Injected so a test can move time forward without waiting. Defaults to the real clock. */
  readonly now?: () => string;
  /** Injected so a test can make the lock token predictable. */
  readonly newLockToken?: () => string;
  /**
   * Only send these aggregate types. Anything else is left PENDING in the outbox, untouched.
   *
   * A transport that can carry some events and not others must NOT be offered the rest: a
   * refusal would walk them up the attempt limit and park them, which looks exactly like losing
   * them. Not claiming them keeps them waiting for the slice that can send them.
   */
  readonly aggregateTypes?: readonly string[];
}

export class OutboxDrain {
  private readonly batchSize: number;
  private readonly policy: OutboxRetryPolicy;
  private readonly now: () => string;
  private readonly newLockToken: () => string;

  constructor(
    private readonly sql: SyncSqlHandle,
    private readonly transport: SyncTransport,
    private readonly options: OutboxDrainOptions
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newLockToken = options.newLockToken ?? (() => crypto.randomUUID());
  }

  async runOnce(): Promise<DrainResult> {
    const nowIso = this.now();
    const reclaimed = reclaimStale(this.sql, { nowIso, staleInFlightMs: this.policy.staleInFlightMs });

    const lockToken = this.newLockToken();
    const leased = leaseBatch(this.sql, {
      limit: this.batchSize,
      nowIso,
      lockToken,
      deviceId: this.options.deviceId,
      aggregateTypes: this.options.aggregateTypes,
    });

    if (leased.length === 0) {
      return { reclaimed, leased: 0, synced: 0, failed: 0, deadLettered: 0, refusals: [], counts: outboxCounts(this.sql) };
    }

    let acks;
    try {
      acks = await this.transport.send(leased.map((event) => event.envelope));
    } catch (error) {
      // The offer failed as a whole. Every claimed row goes back; none is lost, and the local
      // application is untouched.
      const message = error instanceof Error ? error.message : "the service could not be reached";
      // WHY THE KIND IS READ OFF THE ERROR rather than fixed at TRANSIENT.
      //
      // It used to be hardcoded, which made the transport's own classification unreachable for a
      // thrown send: a service refusing the CALL -- a privilege it no longer has, a constraint the
      // batch can never satisfy -- was retried forever instead of being parked, and the queue
      // simply stopped draining with nothing to show an operator but a growing last_error.
      //
      // Absent is still TRANSIENT, deliberately. A batch that may never have arrived says nothing
      // about the events in it, so the unbounded case is the safe default and only a transport
      // that KNOWS the call was refused can say so.
      const kind = error instanceof SyncTransportError ? error.failure ?? "TRANSIENT" : "TRANSIENT";
      let failed = 0;
      let deadLettered = 0;
      const settleIso = this.now();
      for (const event of leased) {
        const status = markFailed(
          this.sql,
          {
            outboxId: event.outboxId,
            attempts: event.attempts,
            transientAttempts: event.transientAttempts,
            error: message,
            kind,
          },
          settleIso,
          this.policy
        );
        if (status === "DEAD_LETTER") deadLettered += 1;
        else failed += 1;
      }
      return {
        reclaimed,
        leased: leased.length,
        synced: 0,
        failed,
        deadLettered,
        transportError: message,
        // Not a verdict on any event: the batch may never have arrived.
        refusals: [],
        counts: outboxCounts(this.sql),
      };
    }

    const byKey = new Map(acks.map((ack) => [ack.dedupeKey, ack]));
    let synced = 0;
    let failed = 0;
    let deadLettered = 0;
    const refusals: OutboxRefusal[] = [];
    const settleIso = this.now();

    for (const event of leased) {
      const ack = byKey.get(event.envelope.dedupeKey);
      if (ack === undefined) {
        // Offered but not answered. Treated as a temporary failure so it is offered again rather
        // than assumed applied.
        const status = markFailed(
          this.sql,
          {
            outboxId: event.outboxId,
            attempts: event.attempts,
            transientAttempts: event.transientAttempts,
            error: "NOT_ACKNOWLEDGED",
            // Offered but not answered. Treated as undeliverable rather than refused: nobody
            // said no, so nothing has been learned about the event itself.
            kind: "TRANSIENT",
          },
          settleIso,
          this.policy
        );
        if (status === "DEAD_LETTER") deadLettered += 1;
        else failed += 1;
        continue;
      }
      if (ack.accepted) {
        markSynced(this.sql, event.outboxId, settleIso);
        synced += 1;
        continue;
      }
      const status = markFailed(
        this.sql,
        {
          outboxId: event.outboxId,
          attempts: event.attempts,
          transientAttempts: event.transientAttempts,
          error: ack.reason ?? "REFUSED",
          // An answer with no kind is read as REFUSED: bounded and visible. Never PERMANENT,
          // which would park it on the first no.
          kind: ack.failure ?? "REFUSED",
        },
        settleIso,
        this.policy
      );
      if (status === "DEAD_LETTER") deadLettered += 1;
      else failed += 1;
      // Only here. The NOT_ACKNOWLEDGED branch above is silence, not a verdict.
      refusals.push({
        aggregateType: event.envelope.aggregateType,
        aggregateId: event.envelope.aggregateId,
        reason: ack.reason ?? "REFUSED",
        parked: status === "DEAD_LETTER",
      });
    }

    return { reclaimed, leased: leased.length, synced, failed, deadLettered, refusals, counts: outboxCounts(this.sql) };
  }
}
