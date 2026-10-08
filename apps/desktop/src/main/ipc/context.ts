import type {
  CancelGatepassUseCase,
  CreateGatepassUseCase,
  AssignMachineContractorUseCase,
  DeleteMachineProgramUseCase,
  SetMachineProgramShiftUseCase,
  DispatchScanUseCase,
  ProcessScanUseCase,
  ReturnScanUseCase,
  IssueRawMaterialScanUseCase,
  ReceiveRawMaterialScanUseCase,
  RemoveMachineProgramLineUseCase,
  RemoveMachineProgramRunUseCase,
  SaveMachineProgramLineUseCase,
  SaveMachineProgramRunUseCase,
  StoreEntryScanUseCase,
  StoreExitScanUseCase,
} from "@erp/application";
import type { BillDoesNotMatchGatepassError, DiscountExceedsAllowedError, GatepassBillingError, PartyBalanceLimitExceededError, SqliteDatabase, StructuredLogger } from "@erp/data";
import { PERMISSION, asOptionalString, asString, isRecord, oneOf } from "@erp/domain";
import { Authorizer } from "../authorize";
import type { MigrationReport, RuntimePaths } from "../runtimePaths";
import { SessionStore } from "../sessionStore";

// Everything an IPC handler module needs, built once in main.ts and handed to each
// register*Handlers(ctx) function. Handlers never reach for globals.

export interface ScanContext {
  factoryId: string;
  workstationId: string;
  deviceId: string;
}

export interface UseCases {
  processScanUseCase: ProcessScanUseCase;
  dispatchScanUseCase: DispatchScanUseCase;
  returnScanUseCase: ReturnScanUseCase;
  storeEntryScanUseCase: StoreEntryScanUseCase;
  receiveRawMaterialScanUseCase: ReceiveRawMaterialScanUseCase;
  issueRawMaterialScanUseCase: IssueRawMaterialScanUseCase;
  storeExitScanUseCase: StoreExitScanUseCase;
  createGatepassUseCase: CreateGatepassUseCase;
  cancelGatepassUseCase: CancelGatepassUseCase;
  machineProgram: {
    assignContractor: AssignMachineContractorUseCase;
    saveLine: SaveMachineProgramLineUseCase;
    saveRun: SaveMachineProgramRunUseCase;
    removeLine: RemoveMachineProgramLineUseCase;
    removeRun: RemoveMachineProgramRunUseCase;
    deleteProgram: DeleteMachineProgramUseCase;
    setShift: SetMachineProgramShiftUseCase;
  };
}

export interface IpcContext {
  db: SqliteDatabase;
  logger: StructuredLogger;
  authorizer: Authorizer;
  sessionStore: SessionStore;
  scanContext: ScanContext;
  deviceId: string;
  paths: RuntimePaths;
  dbPath: string;
  dataMigration: MigrationReport;
  useCases: UseCases;
}

// Legacy parent-module permission codes ("inventory", "scanning", "masters", "billing")
// still grant their child permissions so existing role assignments keep working.
const LEGACY_PARENT_PERMISSIONS: Record<string, readonly string[]> = {
  inventory: [PERMISSION.STOCK, PERMISSION.PRODUCTION_HISTORY],
  scanning: [
    PERMISSION.PRODUCTION_HISTORY,
    PERMISSION.LIVE_PRODUCTION,
    PERMISSION.DAILY_PRODUCTION,
    PERMISSION.LIVE_DISPATCH,
    PERMISSION.DISPATCH_HISTORY,
    PERMISSION.LIVE_RETURN,
    PERMISSION.RETURN_HISTORY,
  ],
  masters: [
    PERMISSION.PARTY_LIST,
    PERMISSION.PARTY_FORM,
    PERMISSION.PRODUCT_LIST,
    PERMISSION.PRODUCT_FORM,
    PERMISSION.DISCOUNT_POLICY,
    PERMISSION.QR_GENERATOR,
    PERMISSION.QR_MANAGEMENT,
  ],
  billing: [
    PERMISSION.CUSTOMER_LEDGER,
    PERMISSION.CUSTOMER_BALANCE,
    PERMISSION.SALE_VOUCHER_FORM,
    PERMISSION.SALE_VOUCHER_LIST,
    PERMISSION.CASH_VOUCHER_FORM,
    PERMISSION.CASH_VOUCHER_LIST,
  ],
};

export const expandLegacyPermissions = (permissions: string[]): string[] => {
  const expanded = new Set(permissions);
  for (const [parent, children] of Object.entries(LEGACY_PARENT_PERMISSIONS)) {
    if (expanded.has(parent)) children.forEach((child) => expanded.add(child));
  }
  return [...expanded];
};

/** Builds the handler context: authoriser bound to the database's sessions plus the session store. */
export function createIpcContext(input: Omit<IpcContext, "authorizer" | "sessionStore" | "deviceId">): IpcContext {
  const authorizer = new Authorizer((token) => {
    const user = input.db.getUserBySessionToken(token);
    if (!user) return null;
    return { ...user, permissions: expandLegacyPermissions(user.permissions) };
  });
  return {
    ...input,
    authorizer,
    sessionStore: new SessionStore(input.paths.dataRoot),
    deviceId: input.scanContext.deviceId,
  };
}

// ─── Helpers shared by more than one handler module ──────────────────────────

export const HISTORY_SORT_COLUMNS = ["event_ts_local", "article_snapshot", "color_snapshot", "size_snapshot"] as const;

/** Narrows a renderer history query (production and dispatch history share the shape). */
export const historyQuery = (query?: Record<string, unknown>) => ({
  search: asString(query?.search),
  fromDate: asOptionalString(query?.fromDate),
  toDate: asOptionalString(query?.toDate),
  page: Number.isFinite(query?.page) ? Number(query?.page) : 1,
  pageSize: Number.isFinite(query?.pageSize) ? Number(query?.pageSize) : 50,
  sortBy: oneOf(query?.sortBy, HISTORY_SORT_COLUMNS, "event_ts_local"),
  sortOrder: query?.sortOrder === "ASC" ? ("ASC" as const) : ("DESC" as const),
});

// @erp/data is loaded dynamically, so the balance-limit error is recognised structurally.
export const isPartyBalanceLimitError = (error: unknown): error is PartyBalanceLimitExceededError =>
  error instanceof Error &&
  (error as { code?: unknown }).code === "PARTY_BALANCE_LIMIT_EXCEEDED" &&
  isRecord((error as { figures?: unknown }).figures);

// Same reasoning: createSaleVoucher refuses a bill for a missing / cancelled / already-billed gatepass.
export const isGatepassBillingError = (error: unknown): error is GatepassBillingError =>
  error instanceof Error &&
  ["GATEPASS_NOT_FOUND", "GATEPASS_CANCELLED", "GATEPASS_ALREADY_BILLED"].includes(String((error as { code?: unknown }).code));

// A bill that would stop saying what its gatepass says. A refused business rule, not a
// fault — the handlers log it as INFO and hand the desk the reason.
export const isBillGatepassMismatchError = (error: unknown): error is BillDoesNotMatchGatepassError =>
  error instanceof Error && (error as { code?: unknown }).code === "BILL_DOES_NOT_MATCH_GATEPASS";

// Same reasoning as isPartyBalanceLimitError: recognised structurally, not by instanceof.
export const isDiscountExceedsAllowedError = (error: unknown): error is DiscountExceedsAllowedError =>
  error instanceof Error &&
  (error as { code?: unknown }).code === "DISCOUNT_EXCEEDS_ALLOWED" &&
  isRecord((error as { figures?: unknown }).figures);
