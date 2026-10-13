import React from "react";
import { STORE_DIRECTION } from "@erp/domain";
import { copy } from "../../../config/copy";
import { StockIcon } from "../StoreIcons";
import { StoreDailyReport } from "./StoreDailyReport";

// Daily Report Store Out — its own page, because Store Out has no tabs: its two scan stations
// stand side by side and the report would have nowhere to go between them. Store In shows the
// same report as one of its tabs.

interface StoreOutReportPageProps {
  token: string;
  /** Back to the Move Out stations. */
  onBack: () => void;
}

export const StoreOutReportPage: React.FC<StoreOutReportPageProps> = ({ token, onBack }) => (
  <div className="si-page sdr-page">
    <header className="si-head">
      <span className="si-head-mark si-head-mark--out" aria-hidden="true">
        <StockIcon />
      </span>
      <div>
        <h1 className="si-title">{copy.storeDailyReport.outTitle}</h1>
        <p className="si-sub">{copy.storeDailyReport.outLine}</p>
      </div>
      <button type="button" className="mo-back" onClick={onBack}>
        {copy.storeDailyReport.backToMoveOut}
      </button>
    </header>
    <main className="sdr-page-body">
      <StoreDailyReport direction={STORE_DIRECTION.OUT} token={token} />
    </main>
  </div>
);
