import React, { useState } from "react";
import type { StoreDayEntry } from "@erp/domain";
import { copy } from "../../../config/copy";
import { formatTime } from "../../../utils/dates";
import { SourceBadge } from "./SourceBadge";
import { entryDetails, entryQuantity, entryWhat } from "./storeDailyReportView";

// Every movement of the day, newest first:
//
//   Time      Kind     What                Quantity   Details                          By
//   6:47 PM   Scan     DANA EVA BLACK      25 KG      From ABC TRADERS · RMQ-000123    aslam
//   6:40 PM   Manual   NAWAAR 5 SOOTAR     700 INCH   Manual move out — 700 INCH       aslam
//
// A busy day is thousands of scans, so the list opens on the latest page and grows on request.

const text = copy.storeDailyReport;
const PAGE = 100;

interface MovementListProps {
  entries: StoreDayEntry[];
  /** Every movement of the day — more than `entries` when the report was capped. */
  total: number;
}

export const MovementList: React.FC<MovementListProps> = ({ entries, total }) => {
  const [shown, setShown] = useState(PAGE);
  const visible = entries.slice(0, shown);

  return (
    <section className="sdr-section" aria-label={text.movementsTitle}>
      <h3 className="sdr-section-title">{text.movementsTitle}</h3>
      <div className="table-wrap sdr-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{text.time}</th>
              <th scope="col">{text.kind}</th>
              <th scope="col">{text.what}</th>
              <th scope="col" className="sdr-num">{text.quantity}</th>
              <th scope="col">{text.details}</th>
              <th scope="col">{text.by}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => (
              <tr key={`${entry.kind}:${entry.id}`}>
                <td className="sdr-time">{formatTime(entry.at)}</td>
                <td>
                  <SourceBadge source={entry.source} />
                </td>
                <td>{entryWhat(entry)}</td>
                <td className="sdr-num sdr-strong">{entryQuantity(entry)}</td>
                <td className="sdr-details">{entryDetails(entry) || "—"}</td>
                <td>{entry.actor ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible.length < total ? (
        <div className="sdr-more">
          <span>{text.showing(visible.length, total)}</span>
          {visible.length < entries.length ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShown((count) => count + PAGE)}>
              {text.showMore}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};
