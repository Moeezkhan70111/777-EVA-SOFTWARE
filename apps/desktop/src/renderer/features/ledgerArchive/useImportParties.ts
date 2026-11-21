import { useEffect, useState } from "react";
import type { LedgerArchiveSide } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { Party } from "../../types/desktopApi";

// The parties an import can match (docs/53). The ledger the import was opened from supplies its own; when the chosen
// files also hold the other side's reports, that side's parties are loaded too, so every statement can be matched.

const PAGE_SIZE = 1000;

export function useImportParties(own: readonly Party[], side: LedgerArchiveSide, needsOther: boolean): { parties: readonly Party[]; failed: boolean } {
  const api = useDesktopApi();
  const [other, setOther] = useState<readonly Party[]>([]);
  const [failed, setFailed] = useState(false);
  const otherSide: LedgerArchiveSide = side === "CUSTOMER" ? "SUPPLIER" : "CUSTOMER";

  useEffect(() => {
    if (!needsOther) return;
    let live = true;
    setFailed(false);
    api.listParties({ status: "ACTIVE", partyType: otherSide, page: 1, pageSize: PAGE_SIZE, sortBy: "party_name", sortOrder: "ASC" })
      .then((result) => { if (live) setOther(result.rows.filter((party) => party.partyType === otherSide)); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [api, needsOther, otherSide]);

  return { parties: needsOther ? [...own, ...other] : own, failed };
}
