// The Claims screen (docs/55; data layer, database/partyClaimRequests.ts and partyClaimPosting.ts).
//
//   listPartyClaimRequests    the store's requests with what Accounts did, one page, by status
//   getPartyClaimRequest      one request with its whole history
//   postPartyClaim            prices a pending request and posts it to the party's ledger
//   rejectPartyClaimRequest   answers a request with "nothing is claimed", and why
//   reversePartyClaim         takes a posted claim off every ledger, and why. Its request is pending again
//
// WHO. Reading needs Claims (administrators hold every permission). Writing needs an ADMINISTRATOR (owner, 21 Nov
// 2026: other users on the accounts computer only view), AND the ACCOUNTS lease (leaseChannels.ts): the gate refuses
// the store and the boss computers whatever the screen sends, so a claim is only ever posted on the accounts computer.
// Who did it comes from the session, never the screen. Every figure is checked again by the data layer, inside its own
// transaction.

import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PARTY_CLAIM_REQUEST_STATUS, PERMISSION, asRecord, asString } from "@erp/domain";
import type { ClaimRequestFilter } from "@erp/data";
import { DATA_KIND, type DataKind } from "../../shared/dataChange";
import { rejection, type SessionUser } from "../authorize";
import { refusalReason } from "../writeRefusal";

/** What an operator is told. One place, for translation later (R21). */
export const CLAIM_MESSAGES = {
  BUSY: "The claim was not saved because another write is in progress. Nothing was changed. Please try again.",
  NOT_SAVED: "The claim could not be saved. Nothing was changed.",
  NOT_LOADED: "The claims could not be loaded. Try again.",
  NOT_FOUND: "That claim request is not on this computer.",
  NOT_ALLOWED_VIEW: "Your account does not have access to Claims.",
  NOT_ALLOWED_POST: "Only an administrator can post, reject or reverse claims.",
} as const;

const FILTERS: ReadonlySet<string> = new Set([...Object.values(PARTY_CLAIM_REQUEST_STATUS), "ALL"]);

/** Exactly what these handlers need. */
export interface PartyClaimContext {
  db: IpcContext["db"];
  logger: Pick<IpcContext["logger"], "log">;
  authorizer: Pick<IpcContext["authorizer"], "requirePermission" | "requireAdmin">;
  deviceId: string;
  /** Tells open screens what changed (main/dataChanged.ts). Nothing when absent. */
  announce?: (kinds: readonly DataKind[]) => void;
}

type Allowed = { ok: true; user: SessionUser } | { ok: false; reason: string };

const filterOf = (value: unknown): ClaimRequestFilter =>
  (FILTERS.has(asString(value)) ? asString(value) : PARTY_CLAIM_REQUEST_STATUS.PENDING) as ClaimRequestFilter;

export function registerPartyClaimHandlers(ctx: PartyClaimContext): void {
  const { db, logger, authorizer, deviceId } = ctx;
  const announce = ctx.announce ?? (() => undefined);
  const log = (severity: "INFO" | "WARNING" | "ERROR", operation: string, message: string, userId?: string) =>
    logger.log({ module: "claims", severity, operation, deviceId, userId, message });

  const allowed = (check: () => SessionUser, denied: string): Allowed => {
    try {
      return { ok: true, user: check() };
    } catch (error) {
      return { ok: false, reason: rejection(error, denied).reason };
    }
  };
  const reader = (event: IpcMainInvokeEvent, opts: unknown) =>
    allowed(() => authorizer.requirePermission(event, PERMISSION.PARTY_CLAIMS, asRecord(opts).token), CLAIM_MESSAGES.NOT_ALLOWED_VIEW);
  const poster = (event: IpcMainInvokeEvent, opts: unknown) =>
    allowed(() => authorizer.requireAdmin(event, asRecord(opts).token), CLAIM_MESSAGES.NOT_ALLOWED_POST);

  /** One write, answered as the data layer answers it, or with the refusal as it is. Announced so balances refresh. */
  const write = <T>(event: IpcMainInvokeEvent, opts: unknown, operation: string, run: (actor: string) => T, describe: (result: T) => string) => {
    const user = poster(event, opts);
    if (!user.ok) return { accepted: false, reason: user.reason };
    try {
      const result = run(user.user.username);
      log("INFO", operation, describe(result), user.user.id);
      announce([DATA_KIND.CASH]);
      return { accepted: true, result };
    } catch (error) {
      const reason = refusalReason(error, CLAIM_MESSAGES.BUSY, CLAIM_MESSAGES.NOT_SAVED);
      log("WARNING", operation, reason, user.user.id);
      return { accepted: false, reason };
    }
  };

  ipcMain.handle(IPC.listPartyClaimRequests, (event, query?: unknown, opts?: unknown) => {
    const user = reader(event, opts);
    if (!user.ok) return { accepted: false, reason: user.reason };
    const fields = asRecord(query);
    try {
      return { accepted: true, page: db.listPartyClaimRequests({ filter: filterOf(fields.filter), limit: Number(fields.limit ?? 100), offset: Number(fields.offset ?? 0) }) };
    } catch (error) {
      log("ERROR", "list", error instanceof Error ? error.message : String(error));
      return { accepted: false, reason: CLAIM_MESSAGES.NOT_LOADED };
    }
  });

  ipcMain.handle(IPC.getPartyClaimRequest, (event, requestId?: unknown, opts?: unknown) => {
    const user = reader(event, opts);
    if (!user.ok) return { accepted: false, reason: user.reason };
    const request = db.getPartyClaimRequest(asString(requestId));
    return request ? { accepted: true, request } : { accepted: false, reason: CLAIM_MESSAGES.NOT_FOUND };
  });

  ipcMain.handle(IPC.postPartyClaim, (event, input?: unknown, opts?: unknown) => {
    const fields = asRecord(input);
    return write(
      event, opts, "post",
      (actor) => db.postClaimFromRequest({ claimId: asString(fields.claimId), requestId: asString(fields.requestId), ratePaisa: Number(fields.ratePaisa), actor }),
      (request) => JSON.stringify({ requestNumber: request.requestNumber, claimNumber: request.posted?.claimNumber, amountPaisa: request.posted?.amountPaisa })
    );
  });

  ipcMain.handle(IPC.rejectPartyClaimRequest, (event, input?: unknown, opts?: unknown) => {
    const fields = asRecord(input);
    return write(
      event, opts, "reject",
      (actor) => db.rejectClaimRequest({ requestId: asString(fields.requestId), reason: fields.reason, actor }),
      (request) => JSON.stringify({ requestNumber: request.requestNumber, status: request.status })
    );
  });

  ipcMain.handle(IPC.reversePartyClaim, (event, input?: unknown, opts?: unknown) => {
    const fields = asRecord(input);
    return write(
      event, opts, "reverse",
      (actor) => db.reversePartyClaim({ claimId: asString(fields.claimId), reason: fields.reason, actor }),
      (reversed) => JSON.stringify(reversed)
    );
  });
}
