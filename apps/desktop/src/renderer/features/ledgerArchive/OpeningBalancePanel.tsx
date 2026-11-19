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

interface Props {
  side: LedgerSide;
  partyId: string;
  partyName: string;
  statements: readonly ArchiveStatement[];
  onChanged: () => void;
}

export const OpeningBalancePanel: React.FC<Props> = ({ side, partyId, partyName, statements, onChanged }) => {
  const { isAdmin } = useSession();
  const opening = useOpeningBalance(partyId);
  const [mode, setMode] = useState<OpeningBalanceMode | null>(null);
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
          onClose={() => setMode(null)}
          onDone={() => { setMode(null); opening.reload(); onChanged(); }}
        />
      )}
    </>
  );
};
