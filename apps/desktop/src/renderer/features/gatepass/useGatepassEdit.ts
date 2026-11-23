import { useCallback, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { copy } from "../../config/copy";
import type { EditGatepassResult, Gatepass, GatepassLineInput } from "../../types/desktopApi";

// The edit the Gatepass screen is making: which stored gatepass, the reason the operator gives, and the one Save. The
// draft itself (cards, quantities, party, transport) is the screen's ordinary draft, loaded from the document.

export interface GatepassChanges {
  partyId: string;
  /** Cartons per colour, from the draft (the operator typed dozens). */
  lines: GatepassLineInput[];
  biltyNumber: string;
  transportVia: string;
  remarks: string;
}

export const useGatepassEdit = (token: string) => {
  const api = useDesktopApi();
  const [editing, setEditing] = useState<Gatepass | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const start = useCallback((document: Gatepass) => {
    setEditing(document);
    setReason("");
  }, []);

  const stop = useCallback(() => {
    setEditing(null);
    setReason("");
  }, []);

  /** One Save. The revision it opened goes with it, so an edit made elsewhere since is refused, not overwritten. */
  const save = useCallback(
    async (changes: GatepassChanges): Promise<EditGatepassResult> => {
      if (!editing) return { accepted: false, outcome: "NOT_FOUND", reason: copy.gatepass.editFailed };
      setSaving(true);
      try {
        return await api.editGatepass(
          {
            gatepassId: editing.id,
            revisionNo: editing.revisionNo,
            partyId: changes.partyId,
            lines: changes.lines,
            biltyNumber: changes.biltyNumber.trim() || null,
            transportVia: changes.transportVia.trim() || null,
            remarks: changes.remarks.trim() || null,
            reason: reason.trim(),
          },
          { token }
        );
      } catch {
        return { accepted: false, outcome: "ERROR", reason: copy.gatepass.editFailed };
      } finally {
        setSaving(false);
      }
    },
    [api, editing, reason, token]
  );

  return { editing, reason, setReason, saving, start, stop, save };
};
