import React, { useState } from "react";
import { formatDozens } from "@erp/domain";
import { Pager } from "../../components/shared/Pager";
import { StateView } from "../../components/shared/StateView";
import { TabStrip } from "../../components/shared/TabStrip";
import { copy } from "../../config/copy";
import type { ManualProductionEntry, ManualProductionPage } from "../../types/desktopApi";
import { formatTime } from "../../utils/dates";
import { ReceiptSummary } from "../receiveProduction/ReceiptSummary";
import type { ManualProductionDay } from "./useManualProduction";
import { VoidEntryDialog } from "./VoidEntryDialog";

/** Voids one entry; resolves with null once done, or the reason it was not. */
type OnVoid = (entryId: string, reason: string) => Promise<string | null>;

// MANUAL PRODUCTION TODAY — in two sections, like Receive Production's:
//
//   [ Details ] [ Summary ]
//   Details: every entry, newest first, a page at a time
//     Entry        Article  Size  Colour  Dozens   Cartons  Machine               Saved at   By
//     MAN-000003   SK6      7/10  RED     10 DZN        20  MACHINE 1 · MP-000123  10:42 AM   admin
//   Summary: the day added up per article, size and colour, with the total (ReceiptSummary, shared)
//
// Both sections come from the one read (listManualProduction), so they always agree.

type Section = "details" | "summary";

const text = copy.manualProduction;
const columns = copy.receiveProduction;

/** A live entry can be voided; a voided one says so in words, with who and why -- never by colour alone. */
const EntryAction: React.FC<{ entry: ManualProductionEntry; onChoose: (entry: ManualProductionEntry) => void }> = ({ entry, onChoose }) =>
  entry.voidedAt ? (
    <>
      <span className="badge badge-muted">{text.voidedBadge}</span> <span className="mpr-program">{text.voidedNote(entry.voidedBy, entry.voidReason)}</span>
    </>
  ) : (
    <button type="button" className="btn btn-ghost btn-sm" aria-label={text.voidButtonLabel(entry.code)} onClick={() => onChoose(entry)}>
      {text.voidButton}
    </button>
  );

const EntryRow: React.FC<{ entry: ManualProductionEntry; latest: boolean; onChoose: (entry: ManualProductionEntry) => void }> = ({ entry, latest, onChoose }) => (
  <tr className={latest ? "rp-row is-latest" : "rp-row"}>
    <td className="rp-qr">
      <code>{entry.code}</code>
      {latest ? <span className="sr-only"> ({text.latest})</span> : null}
    </td>
    <td><strong>{entry.article}</strong></td>
    <td>{entry.size}</td>
    <td>{entry.color}</td>
    <td className="rp-num rp-dozens">{formatDozens(entry.equivalentDozens)}</td>
    <td className="rp-num">{entry.cartons.toLocaleString()}</td>
    <td>{entry.machineName} <span className="mpr-program">· {entry.programCode}</span></td>
    <td className="rp-time">{formatTime(entry.enteredAt)}</td>
    <td>{entry.enteredBy ?? "—"}</td>
    <td><EntryAction entry={entry} onChoose={onChoose} /></td>
  </tr>
);

const Details: React.FC<{ day: ManualProductionDay; page: ManualProductionPage; onVoid: OnVoid }> = ({ day, page, onVoid }) => {
  const pages = Math.max(1, Math.ceil(page.totalEntries / page.pageSize));
  const [voiding, setVoiding] = useState<ManualProductionEntry | null>(null);
  return (
    <>
      <div className="rp-table-wrap">
        <table className="data-table rp-table">
          <caption className="sr-only">{text.activityTitle}</caption>
          <thead>
            <tr>
              <th scope="col">{text.colEntry}</th>
              <th scope="col">{columns.colArticle}</th>
              <th scope="col">{columns.colSize}</th>
              <th scope="col">{columns.colColor}</th>
              <th scope="col" className="rp-num">{columns.colDozens}</th>
              <th scope="col" className="rp-num">{columns.colCartons}</th>
              <th scope="col">{text.colMachine}</th>
              <th scope="col">{text.colAt}</th>
              <th scope="col">{text.colBy}</th>
              <th scope="col">{text.colAction}</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((entry, index) => (
              <EntryRow key={entry.id} entry={entry} latest={page.page === 1 && index === 0} onChoose={setVoiding} />
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 ? <Pager page={day.pageNo} pages={pages} onPage={day.setPageNo} /> : null}
      {voiding ? <VoidEntryDialog entry={voiding} onVoid={onVoid} onClose={() => setVoiding(null)} /> : null}
    </>
  );
};

export const ManualProductionList: React.FC<{ day: ManualProductionDay; onVoid: OnVoid }> = ({ day, onVoid }) => {
  const [section, setSection] = useState<Section>("details");
  const page = day.page;
  const body = () => {
    if (day.loading && !page) return <StateView kind="loading" compact message={text.loading} />;
    if (day.error && !page) return <StateView kind="error" compact message={day.error} onRetry={() => void day.reload()} />;
    if (!page || page.totalEntries === 0) return <StateView kind="empty" compact title={text.emptyTitle} hint={text.emptyHint} />;
    if (section === "summary") return <ReceiptSummary lines={page.summary} totalCartons={page.totalCartons} caption={text.summaryCaption} />;
    return <Details day={day} page={page} onVoid={onVoid} />;
  };

  return (
    <section className="card rp-activity" aria-labelledby="mpr-activity-title">
      <div className="rp-activity-head">
        <h2 id="mpr-activity-title" className="card-title">{text.activityTitle}</h2>
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
      {day.stale ? <p className="rp-stale" role="status">⚠ {text.offline}</p> : null}
      <div role="tabpanel" aria-labelledby={`tab-${section}`} className="rp-section">
        {body()}
      </div>
    </section>
  );
};
