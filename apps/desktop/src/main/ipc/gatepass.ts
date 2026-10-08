// Gatepass documents.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { ACCESS_STATUS, GATEPASS_STATUS, USER_ROLE } from "@erp/domain";
import fs from "node:fs";
import path from "node:path";

export function registerGatepassHandlers(ctx: IpcContext): void {
  const { db, logger, deviceId, paths, useCases } = ctx;
  const { createGatepassUseCase, cancelGatepassUseCase } = useCases;

  // Token-authorised like the store station. "gatepass" covers viewing, creating and
  // printing; "gatepass-cancel" is separate so a clerk cannot undo a document. The use
  // cases own every business rule; nothing here touches stock or QRs.
  const GATEPASS_PERMISSION = "gatepass";

  const GATEPASS_CANCEL_PERMISSION = "gatepass-cancel";

  const resolveGatepassUser = (
    token?: string,
    need: "view" | "cancel" = "view"
  ): { ok: true; userId: string; username: string } | { ok: false; reason: string } => {
    const sessionToken = typeof token === "string" ? token.trim() : "";
    const user = sessionToken ? db.getUserBySessionToken(sessionToken) : null;
    if (!user || user.accessStatus !== ACCESS_STATUS.APPROVED) {
      return { ok: false, reason: "Sign in again to use Gatepass." };
    }
    if (user.role !== USER_ROLE.ADMIN) {
      if (!user.permissions.includes(GATEPASS_PERMISSION)) {
        return { ok: false, reason: "Your account does not have Gatepass access." };
      }
      if (need === "cancel" && !user.permissions.includes(GATEPASS_CANCEL_PERMISSION)) {
        return { ok: false, reason: "Your account cannot cancel a Gatepass. Ask an administrator." };
      }
    }
    return { ok: true, userId: user.id, username: user.username };
  };

  ipcMain.handle(IPC.listGatepassStock, (_event, article?: string, opts?: { token?: string }) => {
    const auth = resolveGatepassUser(opts?.token);
    if (!auth.ok) return { accepted: false, reason: auth.reason, rows: [] };
    try {
      return { accepted: true, rows: db.listStoreStockByArticle(typeof article === "string" ? article : "") };
    } catch (error) {
      logger.log({ module: "gatepass", severity: "ERROR", operation: "list-gatepass-stock", deviceId, message: error instanceof Error ? error.message : String(error) });
      return { accepted: false, reason: "Store stock could not be loaded. Try again.", rows: [] };
    }
  });

  // The whole store in one read, for the article × colour grid on the Gatepass page.
  ipcMain.handle(IPC.listGatepassStoreStock, (_event, opts?: { token?: string }) => {
    const auth = resolveGatepassUser(opts?.token);
    if (!auth.ok) return { accepted: false, reason: auth.reason, rows: [] };
    try {
      return { accepted: true, rows: db.listStoreStock() };
    } catch (error) {
      logger.log({ module: "gatepass", severity: "ERROR", operation: "list-gatepass-store-stock", deviceId, message: error instanceof Error ? error.message : String(error) });
      return { accepted: false, reason: "Store stock could not be loaded. Try again.", rows: [] };
    }
  });

  ipcMain.handle(IPC.createGatepass, async (_event, input?: Record<string, unknown>, opts?: { token?: string }) => {
    const auth = resolveGatepassUser(opts?.token);
    if (!auth.ok) {
      logger.log({ module: "gatepass", severity: "WARNING", operation: "create-gatepass-denied", deviceId, message: auth.reason });
      return { accepted: false, outcome: "NOT_AUTHORIZED", reason: auth.reason };
    }

    const rawLines = Array.isArray(input?.lines) ? (input!.lines as Array<Record<string, unknown>>) : [];
    const lines = rawLines.map((line) => ({
      productVariantId: typeof line?.productVariantId === "string" ? line.productVariantId : "",
      // Deliberately not coerced: a non-number reaches the use case as-is and is rejected there.
      quantity: line?.quantity as number,
      storeQuantitySeen: typeof line?.storeQuantitySeen === "number" ? line.storeQuantitySeen : undefined,
    }));

    try {
      const result = await createGatepassUseCase.execute({
        partyId: typeof input?.partyId === "string" ? input.partyId : "",
        lines,
        biltyNumber: typeof input?.biltyNumber === "string" ? input.biltyNumber : null,
        transportVia: typeof input?.transportVia === "string" ? input.transportVia : null,
        remarks: typeof input?.remarks === "string" ? input.remarks : null,
        actor: auth.username,
        actorUserId: auth.userId,
        deviceId,
      });

      logger.log({
        module: "gatepass",
        severity: result.accepted ? "INFO" : "WARNING",
        operation: "create-gatepass",
        deviceId,
        userId: auth.userId,
        message: result.accepted
          ? `Gatepass created: ${result.code} by ${auth.username} (${result.totalQuantity} cartons)`
          : JSON.stringify({ outcome: result.outcome, reason: result.reason ?? null }),
      });

      return result;
    } catch (error) {
      logger.log({
        module: "gatepass",
        severity: "ERROR",
        operation: "create-gatepass-error",
        deviceId,
        userId: auth.userId,
        message: `Gatepass creation error: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: error instanceof Error ? error.constructor.name : "UNKNOWN",
        errorDetails: error instanceof Error ? error.stack : undefined,
      });
      return {
        accepted: false,
        outcome: "ERROR",
        reason: "The Gatepass could not be saved. Nothing was changed — review the stock and try again.",
      };
    }
  });

  ipcMain.handle(IPC.getGatepass, (_event, gatepassId?: string, opts?: { token?: string }) => {
    const auth = resolveGatepassUser(opts?.token);
    if (!auth.ok) return null;
    const id = typeof gatepassId === "string" ? gatepassId.trim() : "";
    if (!id) return null;
    try {
      return db.getGatepass(id);
    } catch (error) {
      logger.log({ module: "gatepass", severity: "ERROR", operation: "get-gatepass", deviceId, message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });

  ipcMain.handle(IPC.getGatepassByNumber, (_event, gatepassNumber?: number, opts?: { token?: string }) => {
    const auth = resolveGatepassUser(opts?.token);
    if (!auth.ok) return null;
    // Deliberately not coerced from text: the screen sends a whole number or nothing.
    if (typeof gatepassNumber !== "number" || !Number.isInteger(gatepassNumber) || gatepassNumber < 1) return null;
    try {
      return db.getGatepassByNumber(gatepassNumber);
    } catch (error) {
      logger.log({ module: "gatepass", severity: "ERROR", operation: "get-gatepass-by-number", deviceId, message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });

  ipcMain.handle(IPC.countGatepassesByStage, (_event, opts?: { token?: string }) => {
    const auth = resolveGatepassUser(opts?.token);
    if (!auth.ok) return {};
    return db.countGatepassesByStage();
  });

  ipcMain.handle(IPC.getGatepassJourney, (_event, gatepassId?: string, opts?: { token?: string }) => {
    const auth = resolveGatepassUser(opts?.token);
    if (!auth.ok) return null;
    return db.getGatepassJourney(String(gatepassId ?? ""));
  });

  // ─── Delivery proof ─────────────────────────────────────────────────────────
  // DELIVERED means a persisted proof exists, so the file is written BEFORE the row that
  // claims it, and the row and the status change are one database transaction. If that
  // transaction fails the file just written is removed again, so a refused upload leaves
  // neither a half-delivered document nor a file nothing points at.
  //
  // The application owns the stored name. What the operator picked the file as is kept only
  // as a label: a user-supplied name is never joined onto a path, so nothing they type can
  // reach outside the proof store.

  /** What the proof store will accept. Images only — a builty is a photograph. */
  const PROOF_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
  const MAX_PROOF_BYTES = 10 * 1024 * 1024;

  const proofPath = (fileName: string): string | null => {
    // Defence in depth: the name comes from this file, but a stored row could be edited by
    // hand, so anything that is not a plain file name inside the store is refused outright.
    if (!/^[A-Za-z0-9._-]+$/.test(fileName)) return null;
    const full = path.join(paths.deliveryProofsDir, fileName);
    const root = path.resolve(paths.deliveryProofsDir);
    return path.resolve(full).startsWith(root + path.sep) ? full : null;
  };

  ipcMain.handle(
    IPC.saveGatepassDeliveryProof,
    (event, input?: { gatepassId?: string; dataUrl?: string; originalName?: string }, opts?: { token?: string }) => {
      const auth = resolveGatepassUser(opts?.token);
      if (!auth.ok) return { accepted: false, reason: auth.reason };

      const gatepassId = String(input?.gatepassId ?? "").trim();
      const dataUrl = typeof input?.dataUrl === "string" ? input.dataUrl : "";
      if (!gatepassId) return { accepted: false, reason: "That Gatepass could not be found." };

      const match = /^data:([a-z/+-]+);base64,(.+)$/i.exec(dataUrl);
      const mimeType = match?.[1]?.toLowerCase() ?? "";
      const extension = PROOF_TYPES[mimeType];
      if (!match || !extension) {
        return { accepted: false, reason: "Only a photo can be used as a delivery proof (PNG, JPG or WEBP)." };
      }

      const bytes = Buffer.from(match[2]!, "base64");
      if (bytes.byteLength === 0) return { accepted: false, reason: "That file is empty." };
      if (bytes.byteLength > MAX_PROOF_BYTES) {
        return { accepted: false, reason: `That photo is too large. The limit is ${MAX_PROOF_BYTES / (1024 * 1024)} MB.` };
      }

      // Replacing a proof that already exists is a supervisory act, so it is held to the same
      // authority as undoing a Gatepass — through the module’s own boundary, in the main
      // process, not by hiding a button. Recording the FIRST proof is ordinary Gatepass work.
      const existing = db.getGatepassDeliveryProof(gatepassId);
      if (existing) {
        const elevated = resolveGatepassUser(opts?.token, "cancel");
        if (!elevated.ok) return { accepted: false, reason: elevated.reason };
      }

      const fileName = `${gatepassId}-${Date.now()}.${extension}`;
      const target = proofPath(fileName);
      if (!target) return { accepted: false, reason: "The delivery proof could not be saved." };

      // The file first: a committed row must never point at something that is not there.
      try {
        fs.mkdirSync(paths.deliveryProofsDir, { recursive: true });
        fs.writeFileSync(target, bytes);
      } catch (error) {
        logger.log({ module: "gatepass", severity: "ERROR", operation: "delivery-proof-write", deviceId, message: String(error) });
        return { accepted: false, reason: "The photo could not be saved to this computer." };
      }

      try {
        const saved = db.saveGatepassDeliveryProof({
          gatepassId,
          fileName,
          mimeType,
          byteSize: bytes.byteLength,
          originalName: typeof input?.originalName === "string" ? input.originalName.slice(0, 160) : null,
          uploadedBy: auth.username,
        });
        logger.log({
          module: "gatepass", severity: "INFO", operation: saved.delivered ? "delivered" : "delivery-proof-replaced",
          deviceId, message: JSON.stringify({ gatepassId, proofId: saved.proofId, by: auth.username }),
        });
        return { accepted: true, delivered: saved.delivered, proofId: saved.proofId };
      } catch (error) {
        // Nothing was committed, so the file just written belongs to nobody.
        try { fs.unlinkSync(target); } catch { /* already gone */ }
        return { accepted: false, reason: error instanceof Error ? error.message : "The delivery proof could not be saved." };
      }
    }
  );

  /** The proof itself, as a data URL the screen can show. Null when there is none. */
  ipcMain.handle(IPC.getGatepassDeliveryProof, (_event, gatepassId?: string, opts?: { token?: string }) => {
    const auth = resolveGatepassUser(opts?.token);
    if (!auth.ok) return null;
    const proof = db.getGatepassDeliveryProof(String(gatepassId ?? ""));
    if (!proof) return null;
    const target = proofPath(proof.fileName);
    if (!target || !fs.existsSync(target)) return { ...proof, dataUrl: null };
    try {
      return { ...proof, dataUrl: `data:${proof.mimeType};base64,${fs.readFileSync(target).toString("base64")}` };
    } catch {
      return { ...proof, dataUrl: null };
    }
  });

  ipcMain.handle(IPC.getGatepassScanProgress, (_event, gatepassId?: string, opts?: { token?: string }) => {
    const auth = resolveGatepassUser(opts?.token);
    if (!auth.ok) return null;
    return db.getGatepassScanProgress(String(gatepassId ?? ""));
  });

  ipcMain.handle(IPC.listGatepasses, (_event, query?: Record<string, unknown>, opts?: { token?: string }) => {
    const auth = resolveGatepassUser(opts?.token);
    if (!auth.ok) return { rows: [], total: 0, page: 1, pageSize: 25 };
    try {
      return db.listGatepasses({
        search: typeof query?.search === "string" ? query.search : "",
        partyId: typeof query?.partyId === "string" && query.partyId.trim() ? query.partyId : undefined,
        article: typeof query?.article === "string" && query.article.trim() ? query.article : undefined,
        fromDate: typeof query?.fromDate === "string" && query.fromDate ? query.fromDate : undefined,
        toDate: typeof query?.toDate === "string" && query.toDate ? query.toDate : undefined,
        status: typeof query?.status === "string" && query.status in GATEPASS_STATUS ? (query.status as keyof typeof GATEPASS_STATUS) : "ALL",
        page: Number.isFinite(query?.page) ? Number(query?.page) : 1,
        pageSize: Number.isFinite(query?.pageSize) ? Number(query?.pageSize) : 25,
      });
    } catch (error) {
      logger.log({ module: "gatepass", severity: "ERROR", operation: "list-gatepasses", deviceId, message: error instanceof Error ? error.message : String(error) });
      return { rows: [], total: 0, page: 1, pageSize: 25 };
    }
  });

  ipcMain.handle(IPC.cancelGatepass, async (_event, input?: Record<string, unknown>, opts?: { token?: string }) => {
    const auth = resolveGatepassUser(opts?.token, "cancel");
    if (!auth.ok) {
      logger.log({ module: "gatepass", severity: "WARNING", operation: "cancel-gatepass-denied", deviceId, message: auth.reason });
      return { accepted: false, outcome: "NOT_AUTHORIZED", reason: auth.reason };
    }
    try {
      const result = await cancelGatepassUseCase.execute({
        gatepassId: typeof input?.gatepassId === "string" ? input.gatepassId : "",
        reason: typeof input?.reason === "string" ? input.reason : "",
        actor: auth.username,
        actorUserId: auth.userId,
        deviceId,
      });
      logger.log({
        module: "gatepass",
        severity: result.accepted ? "INFO" : "WARNING",
        operation: "cancel-gatepass",
        deviceId,
        userId: auth.userId,
        message: result.accepted ? `Gatepass cancelled: ${result.code} by ${auth.username}` : JSON.stringify({ outcome: result.outcome, reason: result.reason ?? null }),
      });
      return result;
    } catch (error) {
      logger.log({
        module: "gatepass",
        severity: "ERROR",
        operation: "cancel-gatepass-error",
        deviceId,
        userId: auth.userId,
        message: `Gatepass cancellation error: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: error instanceof Error ? error.constructor.name : "UNKNOWN",
        errorDetails: error instanceof Error ? error.stack : undefined,
      });
      return { accepted: false, outcome: "ERROR", reason: "The Gatepass could not be cancelled. Nothing was changed — try again." };
    }
  });
}
