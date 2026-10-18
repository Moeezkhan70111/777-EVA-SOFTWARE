// This computer's document-number range: reading its status, and the one way to record it.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.
//
// Only three operations are exposed, deliberately:
//
//   getNumberBlockStatus   read-only. Which range this computer holds, or why it holds none.
//   adoptNumberBlock       admin-only, one-time, and takes NO range. It records block 1 for the
//                          installation that already holds the company's numbered documents,
//                          after the data layer has proved that is what this computer is.
//   assignNumberBlock      admin-only, one-time, for a SECOND computer: it records a block from
//                          2 to 5, which an administrator reads off the factory's own record of
//                          which machine holds which range.
//
// WHY assignNumberBlock EXISTS NOW. Nothing on a computer can tell whether the range it was
// handed is already in use on another machine -- that has not changed, and is why this channel
// takes a block an administrator must type rather than one the application picks. What changed is
// that refusing outright left a second computer unable to create ANY numbered document, which is
// the gap that stopped a two-computer pilot. The authority is the operator's written assignment;
// the application's job is to refuse the two things it CAN prove wrong: block 1, which belongs to
// the existing-data machine, and a reassignment, which would alias documents that already exist.
//
// The generic settings write cannot reach the range either: IPC.saveSettings goes through
// db.setOperatorSettings, which drops those keys in the data layer that owns them.

import { ipcMain } from "electron";
import type { NumberBlockStatus, NumberRange } from "@erp/data";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { rejection } from "../authorize";

/**
 * Exactly what these handlers need — the two database calls, somewhere to log, the authoriser and
 * the device id. Narrow on purpose: the main process loads @erp/data dynamically, so stating the
 * two methods here lets the boundary be exercised without that module, and makes it obvious that
 * nothing else about the database is in reach from these channels.
 */
export interface NumberBlockContext {
  db: {
    getNumberBlockStatus: () => NumberBlockStatus;
    adoptExistingDataNumberBlock: (updatedBy: string) => NumberRange;
    assignNumberBlock: (block: number, updatedBy: string) => NumberRange;
  };
  logger: Pick<IpcContext["logger"], "log">;
  authorizer: Pick<IpcContext["authorizer"], "requireUser" | "requireAdmin">;
  deviceId: string;
}

// @erp/data is loaded dynamically, so its errors are recognised structurally, exactly as
// ./context.ts recognises the balance-limit and gatepass-billing refusals.
const numberRangeReason = (error: unknown): string | null =>
  error instanceof Error && error.name === "NumberRangeError"
    ? String((error as { reason?: unknown }).reason ?? "")
    : null;

export function registerNumberBlockHandlers(ctx: NumberBlockContext): void {
  const { db, logger, authorizer, deviceId } = ctx;

  ipcMain.handle(IPC.getNumberBlockStatus, (event) => {
    authorizer.requireUser(event);
    return db.getNumberBlockStatus();
  });

  ipcMain.handle(IPC.adoptNumberBlock, (event) => {
    try {
      const admin = authorizer.requireAdmin(event);
      const range = db.adoptExistingDataNumberBlock(admin.username);
      logger.log({
        module: "settings",
        severity: "CRITICAL",
        operation: "adopt-number-block",
        deviceId,
        userId: admin.id,
        message: `Document-number range ${range.lo}-${range.hi} (block ${range.block}) recorded for this computer by ${admin.username}`,
      });
      return { accepted: true as const, range };
    } catch (error) {
      const reason = numberRangeReason(error);
      if (reason !== null) {
        // A refused business rule, not a fault: the operator is told why, and nothing changed.
        logger.log({
          module: "settings",
          severity: "INFO",
          operation: "adopt-number-block",
          deviceId,
          message: `Document-number range not recorded: ${reason}`,
        });
        return {
          accepted: false as const,
          reason: error instanceof Error ? error.message : reason,
          code: reason,
        };
      }
      return rejection(error, "The document-number range could not be recorded.");
    }
  });

  ipcMain.handle(IPC.assignNumberBlock, (event, block?: unknown) => {
    try {
      const admin = authorizer.requireAdmin(event);
      // The renderer sends whatever was typed; the number is settled here and validated by the
      // data layer, which owns the 2-5 bound and the never-reassign rule (R25: the boundary does
      // not trust the renderer, and does not decide the rule either).
      const chosen = typeof block === "number" ? block : Number(block);
      const range = db.assignNumberBlock(chosen, admin.username);
      logger.log({
        module: "settings",
        severity: "CRITICAL",
        operation: "assign-number-block",
        deviceId,
        userId: admin.id,
        message:
          `Document-number range ${range.lo}-${range.hi} (block ${range.block}) assigned to this computer ` +
          `by ${admin.username}`,
      });
      return { accepted: true as const, range };
    } catch (error) {
      const reason = numberRangeReason(error);
      if (reason !== null) {
        logger.log({
          module: "settings",
          severity: "INFO",
          operation: "assign-number-block",
          deviceId,
          message: `Document-number range not assigned: ${reason}`,
        });
        return {
          accepted: false as const,
          reason: error instanceof Error ? error.message : reason,
          code: reason,
        };
      }
      return rejection(error, "The document-number range could not be assigned.");
    }
  });
}
