import React from "react";
import { Pager } from "../../components/shared/Pager";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { formatDate, formatDateTime } from "../../utils/dates";
import type { useAdjustmentHistory } from "./useStockAdjustment";
import type { AdjustmentDocument } from "./stockAdjustmentReply";
import { dozensText } from "./stockAdjustmentDraft";

// Posted documents, newest first, from every computer: never changed once posted. A mistake is corrected by posting
// another document.

const text = copy.stockAdjustment;

const linesText = (document: AdjustmentDocument): string =>
  document.lines.map((line) => `${line.article} ${line.size} ${line.color} ${line.direction === "OUT" ? "−" : "+"}${dozensText(line.cartons)}`).join(" · ");

export const AdjustmentHistory: React.FC<{ history: ReturnType<typeof useAdjustmentHistory> }> = ({ history }) => {
  const body = () => {
    if (history.error) return <StateView kind="error" compact message={history.error} onRetry={() => void history.reload()} />;
    if (history.loading && history.value.documents.length === 0) return <StateView kind="loading" compact message={text.historyLoading} />;
    if (history.value.total === 0) return <StateView kind="empty" compact title={text.historyEmptyTitle} hint={text.historyEmptyHint} />;
    return (
      <>
        <div className="sa-table-wrap">
          <table className="data-table sa-table">
            <thead>
              <tr>
                <th scope="col">{text.numberColumn}</th>
                <th scope="col">{text.dateLabel}</th>
                <th scope="col">{text.kindLabel}</th>
                <th scope="col">{text.linesLabel}</th>
                <th scope="col" className="sa-num">{text.totalInLabel}</th>
                <th scope="col" className="sa-num">{text.totalOutLabel}</th>
                <th scope="col">{text.reasonLabel}</th>
                <th scope="col">{text.postedByColumn}</th>
              </tr>
            </thead>
            <tbody>
              {history.value.documents.map((document) => (
                <tr key={document.id}>
                  <td className="sa-code">{document.code}</td>
                  <td>{formatDate(document.businessDate)}</td>
                  <td>{text.kinds[document.kind]}</td>
                  <td className="sa-lines-cell" title={linesText(document)}>{linesText(document)}</td>
                  <td className="sa-num">{dozensText(document.cartonsIn)}</td>
                  <td className="sa-num">{dozensText(document.cartonsOut)}</td>
                  <td>{document.remarks ? `${document.reason} — ${document.remarks}` : document.reason}</td>
                  <td>{text.postedBy(document.postedBy, formatDateTime(document.postedAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {history.value.pages > 1 ? <Pager page={history.value.page} pages={history.value.pages} onPage={history.setPage} /> : null}
      </>
    );
  };

  return (
    <section className="card sa-card" aria-labelledby="sa-history-title">
      <h3 id="sa-history-title" className="card-title">{text.historyTitle}</h3>
      {body()}
    </section>
  );
};
