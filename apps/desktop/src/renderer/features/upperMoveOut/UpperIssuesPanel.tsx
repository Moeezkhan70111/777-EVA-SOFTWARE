import React from "react";
import { RAW_MATERIAL_QR_STATUS } from "@erp/domain";
import { Pager } from "../../components/shared/Pager";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { UpperIssuePage, UpperIssueRow } from "../../types/desktopApi";
import { formatTime } from "../../utils/dates";
import type { PolledRead } from "../../hooks/usePolledRead";
import { formatUpperQuantity } from "./upperFeedback";

// UPPER OUT DETAILS — what has been issued to the chosen machine today, newest first, from the
// database (one STORE_EXIT event each):
//
//   Upper QR                 Article  Size  Colour  Quantity   Issued at  Status
//   RM_P0001_I0042_000017    SK6      7/10  RED     5 DOZEN    10:42 AM   Issued    ← Latest
//
// Only this machine's issues — another machine's are never mixed in, and a machine chosen later
// never takes over what was issued earlier.

const text = copy.upperMoveOut;

const IssueRow: React.FC<{ issue: UpperIssueRow; latest: boolean }> = ({ issue, latest }) => {
  const back = issue.status === RAW_MATERIAL_QR_STATUS.IN_STORE;
  return (
    <tr className={latest ? "rp-row is-latest" : "rp-row"}>
      <td className="rp-qr">
        <code>{issue.qrId}</code>
        {latest ? <span className="sr-only"> ({text.latest})</span> : null}
      </td>
      <td><strong>{issue.article ?? issue.itemDisplayName}</strong></td>
      <td>{issue.size ?? "—"}</td>
      <td>{issue.colour ?? "—"}</td>
      <td className="rp-num">{formatUpperQuantity({ quantity: issue.quantity, unitCode: issue.unitCode })}</td>
      <td className="rp-time">{formatTime(issue.issuedAt)}</td>
      <td>
        <span className={`badge ${back ? "badge-muted" : "badge-ok"}`}>{back ? text.statusBack : text.statusIssued}</span>
      </td>
    </tr>
  );
};

interface UpperIssuesPanelProps {
  machineName: string | null;
  issues: PolledRead<UpperIssuePage | null> & { pageNo: number; setPageNo: (page: number) => void };
}

export const UpperIssuesPanel: React.FC<UpperIssuesPanelProps> = ({ machineName, issues }) => {
  const page = issues.value;
  const body = () => {
    if (!machineName) return <StateView kind="empty" compact title={text.detailsChooseMachine} />;
    if (issues.loading && !page) return <StateView kind="loading" compact message={text.detailsLoading} />;
    if (issues.error && !page) return <StateView kind="error" compact message={issues.error} onRetry={() => void issues.reload()} />;
    if (!page || page.totals.packets === 0) return <StateView kind="empty" compact title={text.detailsEmptyTitle} hint={text.detailsEmptyHint} />;
    const pages = Math.max(1, Math.ceil(page.totals.packets / page.pageSize));
    return (
      <>
        <div className="rp-table-wrap">
          <table className="data-table rp-table">
            <caption className="sr-only">{text.detailsCaption(machineName)}</caption>
            <thead>
              <tr>
                <th scope="col">{text.colQr}</th>
                <th scope="col">{text.colArticle}</th>
                <th scope="col">{text.colSize}</th>
                <th scope="col">{text.colColour}</th>
                <th scope="col" className="rp-num">{text.colQuantity}</th>
                <th scope="col">{text.colIssuedAt}</th>
                <th scope="col">{text.colStatus}</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((issue, index) => (
                <IssueRow key={issue.eventId} issue={issue} latest={page.page === 1 && index === 0} />
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 ? <Pager page={issues.pageNo} pages={pages} onPage={issues.setPageNo} /> : null}
      </>
    );
  };

  return (
    <section className="card rp-activity" aria-labelledby="um-details-title">
      <div className="rp-activity-head">
        <h2 id="um-details-title" className="card-title">{text.detailsTitle}</h2>
        {machineName ? <span className="rp-activity-note">{text.detailsNote(machineName)}</span> : null}
      </div>
      {issues.stale ? <p className="rp-stale" role="status">⚠ {text.offline}</p> : null}
      {body()}
    </section>
  );
};
