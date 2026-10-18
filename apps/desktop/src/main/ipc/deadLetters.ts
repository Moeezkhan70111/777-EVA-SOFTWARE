// Parked sync events: seeing them, and bringing one back.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.
//
// WHY THIS EXISTS. An outbox row reaches DEAD_LETTER after the service has refused it the agreed
// number of times — a product the cloud has not been given yet, a device that was not enrolled.
// Those are conditions somebody fixes. Until this existed, fixing them changed nothing: the queue
// has no path out of DEAD_LETTER, and `dedupe_key` is UNIQUE with every enqueue written
// ON CONFLICT DO NOTHING, so the carton could not be queued again either. The event was still in
// the local database and had quietly stopped being sent, with only a number on the Health page to
// say so.
//
// Two operations, both admin-only:
//
//   listDeadLetterEvents     read-only. What is parked, why, how many attempts, and when.
//   requeueDeadLetterEvent   ONE named event, put back in the queue. Nothing is retried on its
//                            own, and there is no sweep that could spend five fresh attempts on
//                            every parked row against a cause nobody has looked at.
//
// This is NOT a sync trigger. Requeuing makes an event eligible again; the next pass an
// administrator asks for is what actually sends it.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { rejection } from "../authorize";

/** One parked event as the renderer sees it. No payload: see @erp/sync's DeadLetterEntry. */
export interface DeadLetterView {
  outboxId: string;
  dedupeKey: string;
  aggregateType: string;
  aggregateId: string;
  attempts: number;
  transientAttempts: number;
  error: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Exactly what these handlers need. Narrow on purpose, like NumberBlockContext: the database
 * handle is passed straight to @erp/sync's queue functions and nothing else about the database
 * is in reach from these channels.
 */
export interface DeadLetterContext {
  db: Pick<IpcContext["db"], "db">;
  logger: Pick<IpcContext["logger"], "log">;
  authorizer: Pick<IpcContext["authorizer"], "requireAdmin">;
  deviceId: string;
}

export function registerDeadLetterHandlers(ctx: DeadLetterContext): void {
  const { db, logger, authorizer, deviceId } = ctx;

  ipcMain.handle(IPC.listDeadLetterEvents, async (event) => {
    try {
      authorizer.requireAdmin(event);
    } catch (error) {
      return rejection(error, "The parked events could not be read.");
    }
    // Loaded on demand, exactly as ./cloudSync.ts loads it: a computer that never syncs never
    // loads the module.
    const sync = await import("@erp/sync");
    return { accepted: true as const, entries: sync.deadLetters(db.db) as DeadLetterView[] };
  });

  ipcMain.handle(IPC.requeueDeadLetterEvent, async (event, outboxId?: unknown) => {
    let admin;
    try {
      admin = authorizer.requireAdmin(event);
    } catch (error) {
      return rejection(error, "The event could not be put back in the queue.");
    }

    // ONE event, named explicitly. A string and nothing else: an array would be the bulk
    // recovery this deliberately does not offer.
    const id = typeof outboxId === "string" ? outboxId.trim() : "";
    if (id === "") return { accepted: false as const, reason: "Choose the parked event to put back." };

    const sync = await import("@erp/sync");
    const outcome = sync.requeueDeadLetter(db.db, id, new Date().toISOString());

    if (!outcome.requeued) {
      const reason =
        outcome.reason === "NOT_FOUND"
          ? "That event is not in this computer's queue."
          : `That event is ${outcome.status}, not parked. Only a parked event can be put back.`;
      // A refusal is logged too: an attempt to requeue something that is not parked is worth
      // seeing, and says who tried.
      logger.log({
        module: "sync",
        severity: "INFO",
        operation: "requeue-dead-letter",
        deviceId,
        userId: admin.id,
        message: `Refused to requeue ${id} for ${admin.username}: ${outcome.reason}`,
      });
      return { accepted: false as const, reason };
    }

    const { entry } = outcome;
    logger.log({
      module: "sync",
      severity: "WARNING",
      operation: "requeue-dead-letter",
      deviceId,
      userId: admin.id,
      message:
        `${admin.username} put a parked sync event back in the queue: ` +
        `${entry.aggregateType} ${entry.aggregateId} (${entry.dedupeKey}), ` +
        `parked after ${String(entry.attempts)} refusals at ${entry.updatedAt} — ${entry.error}`,
    });
    return { accepted: true as const, entry: entry as DeadLetterView };
  });
}
