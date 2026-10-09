import React, { Fragment } from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { labelRunTotals, runFigures, runProblem, totalQuantityLabel, type LabelRun } from "./labelRuns";

// SELECTED ITEMS — what Print is about to register, one row per run:
//
//   Code   Name           Packets  Qty per packet  Total qty  Labels
//   RM-12  SK6 · BROWN    [ 10 ]   [ 5 ]           50 DOZEN   10        🗑
//   RM-12  SK6 · BROWN    [ 5 ]    [ 4 ]           20 DOZEN   5         🗑
//   Articles 2 · Packets 15 · Labels 15
//
// Nothing is registered yet. The two typed figures are checked with the same wording the whole
// run is checked by (labelRuns.ts); an empty box is a row still being filled in, not an error,
// so it only holds Print back rather than shouting at the operator.

interface SelectedRunsTableProps {
  runs: LabelRun[];
  onChange: (key: string, patch: Partial<Pick<LabelRun, "packets" | "perPacket">>) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
}

export const SelectedRunsTable: React.FC<SelectedRunsTableProps> = ({ runs, onChange, onRemove, onClear }) => {
  if (runs.length === 0) {
    return <StateView kind="empty" compact title={copy.labelPrint.nothingSelectedTitle} hint={copy.labelPrint.nothingSelectedHint} />;
  }

  const totals = labelRunTotals(runs);
  return (
    <>
      <div className="qrp-selected-head">
        <button type="button" className="qrp-clear" onClick={onClear}>
          {copy.labelPrint.clearAll}
        </button>
      </div>

      <div className="qrp-table-wrap">
        <table className="qrp-table qrp-table--selected">
          <thead>
            <tr>
              <th scope="col">{copy.labelPrint.colCode}</th>
              <th scope="col">{copy.columns.name}</th>
              <th scope="col">{copy.labelPrint.colPackets}</th>
              <th scope="col">{copy.labelPrint.colPerPacket}</th>
              <th scope="col">{copy.labelPrint.colTotalQty}</th>
              <th scope="col">{copy.labelPrint.colLabels}</th>
              <th scope="col">
                <span className="sr-only">{copy.labelPrint.colAction}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <RunRow key={run.key} run={run} onChange={onChange} onRemove={onRemove} />
            ))}

          </tbody>
        </table>
      </div>

      <dl className="qrp-totals">
        <div>
          <dt>{copy.labelPrint.totalArticles}</dt>
          <dd>{totals.articles.toLocaleString()}</dd>
        </div>
        <div>
          <dt>{copy.labelPrint.totalPackets}</dt>
          <dd>{totals.packets.toLocaleString()}</dd>
        </div>
        <div>
          <dt>{copy.labelPrint.totalLabels}</dt>
          <dd>{totals.labels.toLocaleString()}</dd>
        </div>
      </dl>
    </>
  );
};

const RunRow: React.FC<{ run: LabelRun } & Omit<SelectedRunsTableProps, "runs" | "onClear">> = ({ run, onChange, onRemove }) => {
  const problem = runProblem(run);
  const { labels } = runFigures(run);
  return (
    <Fragment>
      <tr>
      <td className="qrp-code">{run.code}</td>
      <td className="qrp-name">
        {run.name}
        <span className="qrp-sub">{run.categoryLabel}</span>
      </td>
      <td>
        <input
          className="qrp-qty"
          inputMode="numeric"
          value={run.packets}
          aria-label={copy.labelPrint.packetsOf(run.name)}
          aria-invalid={problem ? true : undefined}
          onChange={(event) => onChange(run.key, { packets: event.target.value })}
        />
      </td>
      <td>
        <span className="qrp-per-packet">
          <input
            className="qrp-qty"
            inputMode="decimal"
            value={run.perPacket}
            aria-label={copy.labelPrint.perPacketOf(run.packName, run.name)}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => onChange(run.key, { perPacket: event.target.value.replace(",", ".") })}
          />
          <span className="qrp-unit">{run.unitCode || "—"}</span>
        </span>
      </td>
      <td className="qrp-num">{totalQuantityLabel(run)}</td>
      <td className="qrp-num">{labels != null && Number.isFinite(labels) ? labels.toLocaleString() : "—"}</td>
      <td>
        <button type="button" className="qrp-remove" aria-label={copy.labelPrint.removeRun(run.name)} onClick={() => onRemove(run.key)}>
          ✕
        </button>
      </td>
      </tr>
      {/* Its own row so the message can run the width of the table without breaking the grid. */}
      {problem ? (
        <tr className="qrp-problem-row">
          <td colSpan={7} role="alert">
            ⚠ {problem}
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
};
