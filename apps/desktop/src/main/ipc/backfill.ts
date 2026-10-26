// The one-time backfill, from Settings: what the store PC held before it synced, sent up once
// (packages/data/src/database/backfill.ts, docs/37 the stock-screen slice item 3).
//
//   getBackfillPlan   what would go, whether any material's stock does not add up, and when it last
//                     ran. Reads only. Administrators.
//   runBackfill       marks it all for the passes to send. Administrators, and a write under BOTH
//                     leases (leaseChannels.ts): only the store PC, caught up, may send its history.

import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { rejection } from "../authorize";

/** Exactly what these handlers need, like DeadLetterContext. */
export interface BackfillContext {
  db: Pick<IpcContext["db"], "planBackfill" | "runBackfill" | "lastBackfillAt">;
  logger: Pick<IpcContext["logger"], "log">;
  authorizer: Pick<IpcContext["authorizer"], "requireAdmin">;
  deviceId: string;
}

const REFUSED: Readonly<Record<string, string>> = {
  NO_LEASE: "This computer does not hold both the master-data and the store leases. Only the store computer sends its history.",
  STOCK_DOES_NOT_ADD_UP: "Some materials' movements do not add up to their stock. Nothing was sent. Decide what each listed material should be, then try again.",
};

export function registerBackfillHandlers(ctx: BackfillContext): void {
  const { db, logger, authorizer, deviceId } = ctx;

  ipcMain.handle(IPC.getBackfillPlan, (event) => {
    try {
      authorizer.requireAdmin(event);
    } catch (error) {
      return rejection(error, "What would be sent could not be read.");
    }
    return { accepted: true as const, value: { plan: db.planBackfill(), lastAt: db.lastBackfillAt() } };
  });

  ipcMain.handle(IPC.runBackfill, (event) => {
    let admin;
    try {
      admin = authorizer.requireAdmin(event);
    } catch (error) {
      return rejection(error, "The history could not be sent.");
    }
    const outcome = db.runBackfill(new Date().toISOString());
    logger.log({
      module: "sync",
      severity: outcome.done ? "WARNING" : "INFO",
      operation: "backfill",
      deviceId,
      userId: admin.id,
      message: outcome.done
        ? `${admin.username} sent this computer's history: ${JSON.stringify({ ...outcome.plan, mismatches: undefined })}`
        : `${admin.username} asked to send this computer's history, refused: ${outcome.reason} (${String(outcome.plan.mismatches.length)} material(s) do not add up)`,
    });
    if (!outcome.done) return { accepted: false as const, reason: REFUSED[outcome.reason] ?? outcome.reason, plan: outcome.plan };
    return { accepted: true as const, plan: outcome.plan };
  });
}
