import React, { useCallback, useEffect, useState } from "react";
import { STOCK_CORRECTION_MIN_REASON } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { StockCorrectionRequest } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { formatDateTime } from "../../utils/dates";
import { formatQuantity } from "./rawMaterial";
import { CompoundQuantityInput, compoundTotal, quantityUnits } from "./CompoundQuantityInput";
import type { ItemUnitLadder } from "../../types/desktopApi";

// Correcting a raw material's count.
//
// Stock moves by itself: a Raw Material Input scan adds a packet, an Output scan takes one
// away. A manual correction is therefore never a movement — it is somebody saying the system
// is wrong — so it carries a reason and goes to the administrator, and the administrator's
// approval is what applies it. An administrator correcting a count is the approver, so
// theirs applies at once; it is recorded the same way, so every correction has one trail.
//
// This component only collects and displays. The rule about who may apply what lives in the
// main process (see ipc/rawMaterials.ts) — hiding a button is not authorisation.

interface StockCorrectionPanelProps {
  itemId: string;
  displayName: string;
  unitCode: string;
  isAdmin: boolean;
  /** This material's own ladder of units, so a count can be typed as "2 ROLL and 37 INCH". */
  ladder: ItemUnitLadder | null;
  /** Re-reads the material list and its movement history after stock actually changed. */
  onStockChanged: () => Promise<void>;
}

export const StockCorrectionPanel: React.FC<StockCorrectionPanelProps> = ({
  itemId,
  displayName,
  unitCode,
  isAdmin,
  ladder,
  onStockChanged,
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [requests, setRequests] = useState<StockCorrectionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  /** What was typed, per unit — { ROLL: "2", INCH: "37" }. One box when there is no ladder. */
  const [delta, setDelta] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  /** Declining asks for a note first — a refusal with no explanation cannot be acted on. */
  const [declining, setDeclining] = useState(false);
  const [declineNote, setDeclineNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRequests(await api.listStockCorrectionRequestsForItem(itemId, 20));
    } catch {
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, [api, itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = requests.find((request) => request.status === "PENDING") ?? null;
  // The waiting correction has the banner above; repeating it in the list below would be
  // the same fact twice.
  const decided = requests.filter((request) => request.status !== "PENDING");
  // One figure in the unit the stock is held in. The operator never multiplies anything out.
  const quantity = compoundTotal(ladder, delta, unitCode);
  const quantityOk = Number.isFinite(quantity) && quantity !== 0;
  const reasonOk = reason.trim().length >= STOCK_CORRECTION_MIN_REASON;
  const canSubmit = quantityOk && reasonOk && !busy && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      if (isAdmin) {
        // The administrator is the approver, so there is nobody to wait for.
        const result = await api.adjustInventoryStock({ itemId, quantity, note: reason.trim() });
        if (!result.accepted) {
          push("error", "Stock not changed", result.reason ?? "The correction could not be applied.");
          return;
        }
        push("success", "Stock corrected", displayName);
        await onStockChanged();
      } else {
        const result = await api.createStockCorrectionRequest({ itemId, quantity, reason: reason.trim() });
        if (!result.accepted) {
          push("error", "Not sent", result.reason ?? "The correction could not be sent for approval.");
          return;
        }
        push(
          "success",
          "Sent to the administrator",
          `${result.request?.requestCode ?? "Your correction"} is waiting for approval. You will be told the outcome.`
        );
      }
      setDelta({});
      setReason("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const decide = async (request: StockCorrectionRequest, decision: "APPROVED" | "REJECTED") => {
    setDecidingId(request.id);
    try {
      const result = await api.reviewStockCorrectionRequest(
        request.id,
        decision,
        decision === "REJECTED" ? declineNote.trim() || undefined : undefined
      );
      if (!result.accepted) {
        push("error", "Not recorded", result.reason ?? "The decision could not be saved.");
        return;
      }
      if (decision === "APPROVED") {
        push("success", "Approved and applied", `${request.itemDisplayName} changed by ${signed(request)}`);
        await onStockChanged();
      } else {
        push("info", "Declined", `${request.requestedByName ?? "The requester"} has been told. Nothing changed.`);
      }
      setDeclining(false);
      setDeclineNote("");
      await load();
    } finally {
      setDecidingId(null);
    }
  };

  return (
    <div className="rm-correction">
      {pending ? (
        <div className="rm-correction-pending" role="status">
          <strong>⏳ Waiting for approval</strong>
          <span>
            {pending.requestedByName ?? "Someone"} asked for {signed(pending)} — “{pending.reason}” ({pending.requestCode})
          </span>
          {isAdmin ? (
            declining ? (
              <div className="rm-correction-decline">
                <label className="input-label" htmlFor={`rm-decline-${itemId}`}>
                  Tell {pending.requestedByName ?? "the requester"} why
                </label>
                <input
                  id={`rm-decline-${itemId}`}
                  className="form-input"
                  autoFocus
                  value={declineNote}
                  placeholder="e.g. Recount first — the last delivery was not scanned yet"
                  onChange={(event) => setDeclineNote(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void decide(pending, "REJECTED");
                    }
                  }}
                />
                <div className="rm-correction-actions">
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={decidingId === pending.id}
                    onClick={() => void decide(pending, "REJECTED")}
                  >
                    {decidingId === pending.id ? "Saving…" : "Decline correction"}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeclining(false)}>
                    Back
                  </button>
                </div>
              </div>
            ) : (
              <div className="rm-correction-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={decidingId === pending.id}
                  onClick={() => void decide(pending, "APPROVED")}
                >
                  {decidingId === pending.id ? "Applying…" : "Approve & apply"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={decidingId === pending.id}
                  onClick={() => setDeclining(true)}
                >
                  Decline
                </button>
              </div>
            )
          ) : (
            <span className="field-help">A new correction can be sent once this one is decided.</span>
          )}
        </div>
      ) : (
        <>
          <div className="rm-drawer-adjust">
            <div className="form-group">
              {/* The boxes below each carry their own unit label, and the group is named for a
                  screen reader, so this heading is not a label for one control. */}
              <span className="input-label">Correct the count by</span>
              <CompoundQuantityInput
                ladder={ladder}
                value={delta}
                onChange={setDelta}
                label="Correct the count by"
                fallbackUnit={unitCode}
                placeholder={`e.g. -3 ${quantityUnits(ladder, unitCode).slice(-1)[0] ?? unitCode}`.trim()}
                idPrefix={`rm-adjust-${itemId}`}
              />
            </div>
            <div className="form-group rm-correction-reason">
              <label className="input-label" htmlFor={`rm-reason-${itemId}`}>
                Why <span className="required-mark">*</span>
              </label>
              <input
                id={`rm-reason-${itemId}`}
                className="form-input"
                value={reason}
                placeholder="e.g. 3 packets damaged in handling"
                onChange={(event) => setReason(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            </div>
            <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? "Sending…" : isAdmin ? "Apply correction" : "Send for approval"}
            </button>
          </div>
          <p className="field-help">
            {isAdmin
              ? "Scans move stock on their own. Use this only to correct a count — the reason is kept in the history."
              : "Scans move stock on their own. A correction goes to the administrator, and you will be told once it is decided."}
          </p>
          {Object.values(delta).some((typed) => typed.trim() !== "") && !quantityOk ? (
            <p className="rm-correction-error">Enter how much the count is out by, up or down.</p>
          ) : null}
          {reason.trim() !== "" && !reasonOk ? (
            <p className="rm-correction-error">Give a reason the administrator can judge.</p>
          ) : null}
        </>
      )}

      {/* ── What has already been asked for ─────────────────────── */}
      {loading ? (
        <StateView kind="loading" compact message="Loading corrections…" />
      ) : decided.length === 0 ? null : (
        <div className="rm-correction-history">
          <span className="section-label">Past corrections</span>
          {decided.map((request) => (
            <div key={request.id} className={`rm-correction-row rm-correction-row--${request.status.toLowerCase()}`}>
              <span className="rm-correction-badge">{STATUS_LABEL[request.status]}</span>
              <span className="rm-correction-change">{signed(request)}</span>
              <span className="rm-correction-why">
                “{request.reason}”
                {request.reviewNotes ? <em> — {request.reviewNotes}</em> : null}
              </span>
              <span className="rm-correction-who">
                {request.requestedByName ?? "—"} · {formatDateTime(request.requestedAt)}
                {request.reviewedByName ? ` · ${request.status === "APPROVED" ? "approved" : "declined"} by ${request.reviewedByName}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const STATUS_LABEL: Record<StockCorrectionRequest["status"], string> = {
  PENDING: "⏳ Waiting",
  APPROVED: "✓ Applied",
  REJECTED: "✕ Declined",
};

/** "+3 DOZ" / "-2 DOZ" — never a bare number, so the direction is always in words. */
const signed = (request: StockCorrectionRequest): string =>
  `${request.quantity > 0 ? "+" : ""}${formatQuantity(request.quantity)}${request.unitCode ? ` ${request.unitCode}` : ""}`;
