import React, { useState } from "react";
import type { LedgerSide } from "@erp/domain";
import { useSession } from "../auth/SessionContext";
import type { ArchiveStatement } from "./archiveReplies";
import { OpeningBalanceDialog } from "./OpeningBalanceDialog";
import { OpeningBalanceStrip } from "./OpeningBalanceStrip";
import { useOpeningBalance } from "./useOpeningBalance";
import type { OpeningBalanceMode } from "./useOpeningBalanceForm";

// A party's opening balance on its ledger (docs/53): the strip, and the dialog an administrator posts, corrects or
// reverses it with. After a change the ledger's own figures are reloaded, so the Current Balance shows it at once.
//
// The Customer Ledger reads the opening balance itself (its balance card says whether the old software's balance is
// in) and opens the dialog from there, so it passes `opening` and `mode`; without them the panel keeps its own.

interface Props {
  side: LedgerSide;
  partyId: string;
  partyName: string;
  statements: readonly ArchiveStatement[];
  onChanged: () => void;
  /** The opening balance as the page already reads it; the panel then reads none of its own. */
  opening?: ReturnType<typeof useOpeningBalance>;
  /** The open dialog, when the page decides it. */
  mode?: OpeningBalanceMode | null;
  onMode?: (mode: OpeningBalanceMode | null) => void;
  /** Open the post dialog filled from the latest archived statement. */
  prefill?: boolean;
}

export const OpeningBalancePanel: React.FC<Props> = ({ side, partyId, partyName, statements, onChanged, ...control }) => {
  const { isAdmin } = useSession();
  const own = useOpeningBalance(control.opening ? "" : partyId);
  const opening = control.opening ?? own;
  const [ownMode, setOwnMode] = useState<OpeningBalanceMode | null>(null);
  const mode = control.mode !== undefined ? control.mode : ownMode;
  const setMode = control.onMode ?? setOwnMode;
  const view = opening.state.status === "ready" ? opening.state.view : null;
  return (
    <>
      <OpeningBalanceStrip side={side} state={opening.state} canChange={isAdmin} onOpen={setMode} onRetry={opening.reload} />
      {mode && (
        <OpeningBalanceDialog
          side={side}
          mode={mode}
          partyId={partyId}
          partyName={partyName}
          view={view}
          statements={statements}
          prefill={control.prefill}
          onClose={() => setMode(null)}
          onDone={() => { setMode(null); opening.reload(); onChanged(); }}
        />
      )}
    </>
  );
};
