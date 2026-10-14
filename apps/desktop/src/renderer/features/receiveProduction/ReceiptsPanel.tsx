import React, { useState } from "react";
import { Pager } from "../../components/shared/Pager";
import { StateView } from "../../components/shared/StateView";
import { TabStrip } from "../../components/shared/TabStrip";
import { copy } from "../../config/copy";
import type { ProductionReceipt } from "../../types/desktopApi";
import { formatTime } from "../../utils/dates";
import { qrStageMeta } from "../../utils/qrLifecycle";
import { ReceiptSummary } from "./ReceiptSummary";
import type { ProductionReceiptsState } from "./useProductionReceipts";

// RECEIVED PRODUCTION — today's receipts, in two sections:
//
//   [ Details ] [ Summary ]
//   Details: every carton scanned, newest first, a page at a time
//     Carton QR                    Article  Size   Colour      Received at   Status
//     SK6_BLACKGREY_7/10_000016    SK6      7/10   BLACKGREY   10:42 AM      Produced   ← Latest
//   Summary: the day added up per article, size and colour, with the total (ReceiptSummary)
//
// Status is where the carton is NOW (it may have moved on to the store since), read from the
// database like every other figure here. Both sections come from the same read, so they always agree.

type Section = "details" | "summary";

const text = copy.receiveProduction;

const ReceiptRow: React.FC<{ receipt: ProductionReceipt; latest: boolean }> = ({ receipt, latest }) => {
  const stage = qrStageMeta(receipt.stage);
  return (
    <tr className={latest ? "rp-row is-latest" : "rp-row"}>
      <td className="rp-qr">
        <code>{receipt.qrId}</code>
        {latest ? <span className="sr-only"> ({text.latest})</span> : null}
      </td>
      <td><strong>{receipt.article}</strong></td>
      <td>{receipt.size}</td>
      <td>
        {receipt.color}
        {receipt.grade ? <span className="badge badge-warn rp-grade" aria-label={text.bCarton} title={text.bCarton}>B</span> : null}
      </td>
      <td className="rp-time">{formatTime(receipt.receivedAt)}</td>
      <td>
        <span className={`badge ${stage.badge}`} title={stage.hint}>{stage.short}</span>
      </td>
    </tr>
  );
};

export const ReceiptsPanel: React.FC<{ receipts: ProductionReceiptsState }> = ({ receipts }) => {
  const [section, setSection] = useState<Section>("details");
  const page = receipts.page;
  const body = () => {
    if (receipts.loading && !page) return <StateView kind="loading" compact message={text.loading} />;
    if (receipts.error && !page) return <StateView kind="error" compact message={receipts.error} onRetry={() => void receipts.reload()} />;
    if (!page || page.totalCartons === 0) return <StateView kind="empty" compact title={text.emptyTitle} hint={text.emptyHint} />;
    if (section === "summary") return <ReceiptSummary page={page} />;
    const pages = Math.max(1, Math.ceil(page.totalCartons / page.pageSize));
    return (
      <>
        <div className="rp-table-wrap">
          <table className="data-table rp-table">
            <caption className="sr-only">{text.activityTitle}</caption>
            <thead>
              <tr>
                <th scope="col">{text.colQr}</th>
                <th scope="col">{text.colArticle}</th>
                <th scope="col">{text.colSize}</th>
                <th scope="col">{text.colColor}</th>
                <th scope="col">{text.colReceivedAt}</th>
                <th scope="col">{text.colStatus}</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((receipt, index) => (
                <ReceiptRow key={receipt.qrId} receipt={receipt} latest={page.page === 1 && index === 0} />
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 ? <Pager page={receipts.pageNo} pages={pages} onPage={receipts.setPageNo} /> : null}
      </>
    );
  };

  return (
    <section className="card rp-activity" aria-labelledby="rp-activity-title">
      <div className="rp-activity-head">
        <h2 id="rp-activity-title" className="card-title">{text.activityTitle}</h2>
        <span className="rp-activity-note">{text.activityNote}</span>
      </div>
      <TabStrip
        items={[
          { id: "details", label: text.sectionDetails },
          { id: "summary", label: text.sectionSummary },
        ]}
        active={section}
        onSelect={setSection}
        label={text.sectionsLabel}
      />
      {receipts.stale ? <p className="rp-stale" role="status">⚠ {text.offline}</p> : null}
      <div role="tabpanel" aria-labelledby={`tab-${section}`} className="rp-section">
        {body()}
      </div>
    </section>
  );
};
