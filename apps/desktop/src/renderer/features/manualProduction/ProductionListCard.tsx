import React, { useState } from "react";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { byMachine, cartonsOf, dozensText, type DraftLine, type MachineGroup } from "./manualProductionDraft";
import type { SaveOutcome } from "./useProductionList";

// STEP 3, THE LIST: everything added, one block per machine, each line removable, the totals, and "Save production"
// (asks first: every line is saved together, or none). Kept on this computer until it is saved or cleared.

const text = copy.manualProductionPage;

interface ProductionListCardProps {
  lines: readonly DraftLine[];
  saving: boolean;
  outcome: SaveOutcome | null;
  onRemove: (key: string) => void;
  onClear: () => void;
  onSave: () => Promise<string | null>;
}

const lineName = (line: DraftLine): string => `${line.machineName} ${line.article} ${line.size} ${line.color}`;

const MachineBlock: React.FC<{ group: MachineGroup; onRemove: (key: string) => void }> = ({ group, onRemove }) => (
  <div className="mnp-machine-block">
    <h3 className="mnp-machine-name">{text.listMachine(group.machineName, dozensText(group.cartons))}</h3>
    <table className="data-table mnp-lines">
      <caption className="sr-only">{group.machineName}</caption>
      <thead>
        <tr>
          <th scope="col">{text.colArticle}</th>
          <th scope="col">{text.colSize}</th>
          <th scope="col">{text.colColour}</th>
          <th scope="col" className="rp-num">{text.colDozens}</th>
          <th scope="col" className="rp-num">{text.colCartons}</th>
          <th scope="col"><span className="sr-only">{text.remove}</span></th>
        </tr>
      </thead>
      <tbody>
        {group.lines.map((line) => (
          <tr key={line.key}>
            <td><strong>{line.article}</strong></td>
            <td>{line.size}</td>
            <td><span className="mnp-colour"><ColorSwatch color={line.color} />{line.color}</span></td>
            <td className="rp-num"><strong>{dozensText(line.cartons)}</strong></td>
            <td className="rp-num">{line.cartons.toLocaleString()}</td>
            <td className="mnp-remove-cell">
              <button type="button" className="btn btn-ghost btn-sm" aria-label={text.removeLabel(lineName(line))} onClick={() => onRemove(line.key)}>{text.remove}</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const Outcome: React.FC<{ outcome: SaveOutcome }> = ({ outcome }) =>
  outcome.kind === "saved" ? (
    <p className="mpr-outcome is-saved" role="status">
      {text.saved(outcome.lines, dozensText(outcome.cartons))} {outcome.duplicates > 0 ? text.savedAgain : null}
    </p>
  ) : (
    <p className="mpr-outcome is-refused" role="alert"><strong>{text.notSaved}</strong> {outcome.message}</p>
  );

export const ProductionListCard: React.FC<ProductionListCardProps> = ({ lines, saving, outcome, onRemove, onClear, onSave }) => {
  const [confirming, setConfirming] = useState(false);
  const groups = byMachine(lines);
  const cartons = cartonsOf(lines);
  return (
    <section className="card mnp-card mnp-list-card" aria-labelledby="mnp-list-title">
      <div className="mnp-card-head">
        <h2 id="mnp-list-title" className="mnp-card-title">
          <span className="qr-step-num" aria-hidden="true">3</span>
          {text.listTitle}
        </h2>
        {lines.length > 0 ? <span className="mnp-list-totals">{text.listTotals(lines.length, dozensText(cartons), cartons)}</span> : null}
      </div>
      {lines.length === 0 ? <StateView kind="empty" compact title={text.listEmptyTitle} hint={text.listEmptyHint} /> : null}
      {groups.map((group) => <MachineBlock key={group.machineId} group={group} onRemove={onRemove} />)}
      {lines.length > 0 ? (
        <div className="mnp-actions">
          <span className="mnp-note">{text.keptNote}</span>
          <button type="button" className="btn btn-secondary" onClick={onClear} disabled={saving}>{text.clearList}</button>
          <button type="button" className="btn btn-primary mnp-save" onClick={() => setConfirming(true)} disabled={saving}>{saving ? text.saving : text.save}</button>
        </div>
      ) : null}
      {outcome ? <Outcome outcome={outcome} /> : null}
      {confirming ? (
        <ConfirmDialog
          title={text.saveTitle}
          facts={[
            { label: text.factLines, value: lines.length.toLocaleString() },
            { label: text.factMachines, value: groups.map((group) => group.machineName).join(", ") },
            { label: text.factDozens, value: dozensText(cartons) },
            { label: text.factCartons, value: cartons.toLocaleString() },
          ]}
          explain={text.saveExplain}
          confirmLabel={text.save}
          busyLabel={text.saving}
          tone="primary"
          onConfirm={onSave}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
};
