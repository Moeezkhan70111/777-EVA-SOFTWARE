import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { GatepassDeliveryProof as Proof, GatepassStatus } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { formatDateTime } from "../../utils/dates";

// The builty photo, which is what finishes a Gatepass.
//
// Recording it is the whole of the DISPATCHED → DELIVERED step: the backend writes the photo,
// the proof row and the status change together, so this screen never advances anything itself
// and never claims delivery it has not been told about. A refusal is shown as it came back and
// leaves the document exactly where it was.
//
// Replacing an existing proof keeps the Gatepass DELIVERED — it corrects the paperwork, it is
// not a second delivery — and the backend holds it to the same authority as undoing a Gatepass.

/** Images only: a builty is a photograph, and the proof store accepts nothing else. */
const ACCEPTED = "image/png,image/jpeg,image/webp";

interface GatepassDeliveryProofProps {
  gatepassId: string;
  status: GatepassStatus;
  token: string;
  /** Re-reads the document and its journey once the proof has been recorded. */
  onDelivered: () => Promise<void> | void;
}

export const GatepassDeliveryProof: React.FC<GatepassDeliveryProofProps> = ({ gatepassId, status, token, onDelivered }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [proof, setProof] = useState<Proof | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProof(await api.getGatepassDeliveryProof(gatepassId, { token }));
    } catch {
      setProof(null);
    } finally {
      setLoading(false);
    }
  }, [api, gatepassId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = () => {
    setProblem(null);
    fileRef.current?.click();
  };

  const upload = async (file: File) => {
    setSaving(true);
    setProblem(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error("That file could not be read."));
        reader.readAsDataURL(file);
      });

      const result = await api.saveGatepassDeliveryProof({ gatepassId, dataUrl, originalName: file.name }, { token });
      if (!result.accepted) {
        // The document is untouched: it still says what it said before.
        setProblem(result.reason ?? copy.common.unknownError);
        return;
      }
      push("success", result.delivered ? "Delivered" : "Delivery proof replaced");
      await load();
      await onDelivered();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : copy.common.unknownError);
    } finally {
      setSaving(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // Nothing to show until the goods have actually gone.
  if (status !== "DISPATCHED" && status !== "DELIVERED") return null;

  const delivered = status === "DELIVERED";

  return (
    <section className="card gp-card gp-proof" aria-label="Delivery proof">
      <div className="card-header">
        <h2 className="card-title">Delivery proof</h2>
        {proof ? <span className="card-eyebrow">Builty photo</span> : null}
      </div>

      {loading ? (
        <StateView kind="loading" compact message={copy.common.loading} />
      ) : proof ? (
        <>
          {proof.dataUrl ? (
            <img className="gp-proof-photo" src={proof.dataUrl} alt={`Delivery proof for this Gatepass${proof.originalName ? ` — ${proof.originalName}` : ""}`} />
          ) : (
            <p className="gp-proof-missing" role="alert">
              ⚠ The photo file is missing from this computer. The record of it is kept below.
            </p>
          )}
          <dl className="gp-proof-facts">
            <div>
              <dt>Uploaded</dt>
              <dd>{formatDateTime(proof.uploadedAt)}</dd>
            </div>
            <div>
              <dt>Uploaded by</dt>
              <dd>{proof.uploadedBy ?? "—"}</dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="field-help">
          {delivered
            ? "This Gatepass is delivered but its photo is no longer on this computer."
            : "Upload the builty photo to finish this Gatepass. Nothing is delivered until the photo is saved."}
        </p>
      )}

      {problem ? (
        <p className="gp-proof-problem" role="alert">
          ⚠ {problem}
        </p>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED}
        className="sr-only"
        aria-label={proof ? "Choose a replacement builty photo" : "Choose the builty photo"}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <button type="button" className={proof ? "btn btn-secondary" : "btn btn-primary"} disabled={saving} onClick={choose} data-testid="gatepass-upload-proof">
        {saving ? "Saving…" : proof ? "Replace proof" : "Upload Builty Photo"}
      </button>
    </section>
  );
};
