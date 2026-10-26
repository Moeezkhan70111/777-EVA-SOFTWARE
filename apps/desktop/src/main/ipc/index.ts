import type { IpcContext } from "./context";
import { registerSessionHandlers } from "./session";
import { registerUsersHandlers } from "./users";
import { registerWorkspaceHandlers } from "./workspace";
import { registerRawMaterialsHandlers } from "./rawMaterials";
import { registerProductsHandlers } from "./products";
import { registerQrCodesHandlers } from "./qrCodes";
import { registerRawMaterialQrHandlers } from "./rawMaterialQr";
import { registerMachineProgramHandlers } from "./machinePrograms";
import { registerReportsHandlers } from "./reports";
import { registerScanningHandlers } from "./scanning";
import { registerStoreHandlers } from "./store";
import { registerGatepassHandlers } from "./gatepass";
import { registerPartiesHandlers } from "./parties";
import { registerSalesHandlers } from "./sales";
import { registerCashHandlers } from "./cash";
import { registerPurchasesHandlers } from "./purchases";
import { registerSystemHandlers } from "./system";
import { registerNumberBlockHandlers } from "./numberBlock";
import { registerCloudSyncHandlers } from "./cloudSync";
import { registerDeadLetterHandlers } from "./deadLetters";
import { registerPrintingHandlers } from "./printing";
import { registerContractorLedgerHandlers } from "./contractorLedger";
import { registerUpperMoveOutHandlers } from "./upperMoveOut";
import { registerManualProductionHandlers } from "./manualProduction";
import { registerUpdateHandlers } from "./updates";
import { installLeaseGate } from "../leaseGuard";
import { registerLeaseHandlers } from "./leases";
import { registerSyncWaitingHandlers } from "./syncWaiting";
import { registerBackfillHandlers } from "./backfill";

export type { IpcContext } from "./context";
export { createIpcContext } from "./context";

/** Registers every IPC handler. One module per feature; see shared/ipcChannels.ts for the channel list. */
export function registerIpcHandlers(ctx: IpcContext): void {
  // Before any handler exists: a leased channel called before this would be refused (fails closed).
  installLeaseGate({ db: ctx.db, deviceId: ctx.deviceId, dataRoot: ctx.paths.dataRoot });
  registerSessionHandlers(ctx);
  registerUsersHandlers(ctx);
  registerWorkspaceHandlers(ctx);
  registerRawMaterialsHandlers(ctx);
  registerProductsHandlers(ctx);
  registerQrCodesHandlers(ctx);
  registerRawMaterialQrHandlers(ctx);
  registerMachineProgramHandlers(ctx);
  registerReportsHandlers(ctx);
  registerScanningHandlers(ctx);
  registerStoreHandlers(ctx);
  registerGatepassHandlers(ctx);
  registerPartiesHandlers(ctx);
  registerSalesHandlers(ctx);
  registerCashHandlers(ctx);
  registerPurchasesHandlers(ctx);
  registerSystemHandlers(ctx);
  registerNumberBlockHandlers(ctx);
  registerCloudSyncHandlers(ctx);
  registerDeadLetterHandlers(ctx);
  registerPrintingHandlers(ctx);
  registerContractorLedgerHandlers(ctx);
  registerUpperMoveOutHandlers(ctx);
  registerManualProductionHandlers(ctx);
  registerUpdateHandlers(ctx);
  registerLeaseHandlers(ctx);
  registerSyncWaitingHandlers(ctx);
  registerBackfillHandlers(ctx);
}
