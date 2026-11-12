import React, { useState } from "react";
import { CARTON_ADJUSTMENT_DIRECTION, type CartonAdjustmentKind } from "@erp/domain";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { formatDate } from "../../utils/dates";
import { documentProblem, dozensText, resultOf, totalsOf, type DraftHeader, type DraftLine } from "./stockAdjustmentDraft";
import type { PostOutcome } from "./useStockAdjustment";
import { ResultCell } from "./ResultCell";

// The document as it will be posted: every line with the figure it leaves, the totals, and Post, which asks first.

const text = copy.stockAdjustment;

interface DocumentLinesProps {
  header: DraftHeader;
  lines: readonly DraftLine[];
  busy: boolean;
  canWrite: boolean;
  outcome: PostOutcome | null;
  onRemove: (key: string) => void;
  onPost: () => Promise<string | null>;
}

const movementText = (kind: CartonAdjustmentKind, line: DraftLine): string =>
  kind === "OPENING" ? text.kinds.OPENING : text.directions[line.direction];

const signed = (line: DraftLine): string => `${line.direction === CARTON_ADJUSTMENT_DIRECTION.OUT ? "−" : "+"}${dozensText(line.cartons)}`;

const Outcome: React.FC<{ outcome: PostOutcome }> = ({ outcome }) =>
  outcome.kind === "posted" ? (
    <p className="mpr-outcome is-saved" role="status"><strong>{text.postedTitle}</strong> {outcome.message}</p>
  ) : (
    <p className="mpr-outcome is-refused" role="alert"><strong>{text.refusedTitle}</strong> {outcome.message}</p>
  );

export const DocumentLines: React.FC<DocumentLinesProps> = ({ header, lines, busy, canWrite, outcome, onRemove, onPost }) => {
  const [confirming, setConfirming] = useState(false);
  const problem = documentProblem(header, lines);
  const totals = totalsOf(lines);
  const facts = [
    { label: text.kindLabel, value: text.kinds[header.kind] },
    { label: text.dateLabel, value: formatDate(header.businessDate) },
    { label: text.linesLabel, value: String(lines.length) },
    { label: text.totalInLabel, value: dozensText(totals.cartonsIn) },
    { label: text.totalOutLabel, value: dozensText(totals.cartonsOut) },
    { label: text.reasonLabel, value: header.reason.trim() },
  ];

  return (
    <section className="card sa-card" aria-labelledby="sa-lines-title">
      <h3 id="sa-lines-title" className="card-title">{text.linesTitle}</h3>
      {lines.length === 0 ? (
        <StateView kind="empty" compact title={text.noLinesTitle} hint={text.noLinesHint} />
      ) : (
        <div className="sa-table-wrap">
          <table className="data-table sa-table">
            <thead>
              <tr>
                <th scope="col">{text.articleLabel}</th>
                <th scope="col">{text.colorLabel}</th>
                <th scope="col">{text.sizeColumn}</th>
                <th scope="col">{text.movementColumn}</th>
                <th scope="col" className="sa-num">{text.inStoreColumn}</th>
                <th scope="col" className="sa-num">{text.cartonsColumn}</th>
                <th scope="col" className="sa-num">{text.resultColumn}</th>
                <th scope="col"><span className="sr-only">{text.removeColumn}</span></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.key}>
                  <td>{line.article}</td>
                  <td>{line.color}</td>
                  <td>{line.size}</td>
                  <td>{movementText(header.kind, line)}</td>
                  <td className="sa-num">{dozensText(line.inStore)}</td>
                  <td className="sa-num">{signed(line)}</td>
                  <ResultCell cartons={resultOf(line)} />
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={text.removeLine(line.article, line.size, line.color)} onClick={() => onRemove(line.key)}>
                      {text.remove}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={5}>{text.totalsRow}</th>
                <td className="sa-num">{text.totals(dozensText(totals.cartonsIn), dozensText(totals.cartonsOut))}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {outcome ? <Outcome outcome={outcome} /> : null}
      <div className="sa-actions">
        {problem && lines.length > 0 ? <span className="sa-hint">{problem}</span> : null}
        <button type="button" className="btn btn-primary" disabled={problem !== null || busy || !canWrite} onClick={() => setConfirming(true)}>
          {busy ? text.posting : text.post[header.kind]}
        </button>
      </div>
      {confirming ? (
        <ConfirmDialog title={text.confirmTitle[header.kind]} facts={facts} explain={text.confirmExplain} warning={text.confirmWarning}
          confirmLabel={text.post[header.kind]} busyLabel={text.posting} tone="primary" onConfirm={onPost} onClose={() => setConfirming(false)} />
      ) : null}
    </section>
  );
};
