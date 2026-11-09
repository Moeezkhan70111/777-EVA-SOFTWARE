// How a screen handled an announced change, written to app.log (shared/dataChange.ts).
//
// The pass logs "Change <id>: applied ..." when it tells the windows (cloudSyncPass.ts). A screen that
// traces then reports, under the same id, that it heard the change, started its re-read, got an answer,
// and showed it. Reading app.log for one id says at which step a change stopped.
//
// Not leased and not authorised: it changes nothing and answers nothing, and a screen may report while
// nobody is signed in. Every field is checked and bounded before it is logged; anything else is dropped.

import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import { readDataChangeTrace } from "../../shared/dataChange";
import type { IpcContext } from "./context";

export interface DataChangeTraceContext {
  logger: Pick<IpcContext["logger"], "log">;
  deviceId: string;
}

export function registerDataChangeTraceHandler(ctx: DataChangeTraceContext): void {
  ipcMain.handle(IPC.traceDataChange, (_event, input?: unknown) => {
    const trace = readDataChangeTrace(input);
    if (trace === null) return;
    ctx.logger.log({
      module: "sync",
      severity: "INFO",
      operation: "data-change-trace",
      deviceId: ctx.deviceId,
      message: `Change ${trace.id}: ${trace.screen} ${trace.stage}${trace.detail ? ` (${trace.detail})` : ""}.`,
    });
  });
}
