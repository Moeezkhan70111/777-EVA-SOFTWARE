import React, { useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { Modal } from "../../components/shared/Modal";
import { SizeColourGrid, type GridBoxProps, type GridSize } from "../../components/shared/SizeColourGrid";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { cellKey, dozensText, productionGrid, type ProductionGrid } from "./manualProductionDraft";
import type { ProductChoice } from "./productChoices";
import { boxCartons, editChanges, editProblems, savedByCell, type EditChange } from "./productionEdit";
import { useEditProduction } from "./useEditProduction";

// EDIT TODAY'S PRODUCTION of one article on one machine (owner, 14 Nov 2026), in the same grid it was entered in:
//
//   Edit SK12 · MACHINE 1 · today
//   Size │ BLACKBLUE │ BLACKRED │ GREEN
//   7/10 │  [ 1 ]    │  [ 3 ]   │ [ 54 ]        a changed box says what it was: "was 5"
//   4/6  │  [ 2 ]    │  [ 10 ]  │   —
//   Changes: 7/10 BLACKRED: 5 -> 3 dozen                              [ Cancel ] [ Review changes ]
//
// Review asks first, naming every change, then saves them together: each changed figure is reversed and recorded
// again, so store stock and the Contractor Ledger follow (database/manualProductionEdit.ts).

const text = copy.productionEdit;
const entryText = copy.manualProductionPage;

interface EditProductionDialogProps {
  machineName: string;
  article: string;
  products: readonly ProductChoice[];
  /** Saved: how many figures changed. */
  onSaved: (changed: number) => void;
  onClose: () => void;
}

type Edit = ReturnType<typeof useEditProduction>;

const cellClass = (problem: string | undefined, changed: boolean): string => {
  if (problem) return "sa-cell is-invalid";
  return changed ? "sa-cell is-typed" : "sa-cell";
};

const Cell: React.FC<{ size: GridSize; colour: string; box: GridBoxProps; grid: ProductionGrid; edit: Edit; saved: number; problem?: string }> = ({ size, colour, box, grid, edit, saved, problem }) => {
  if (!grid.made.get(size.id)?.has(colour)) return <td className="sa-cell is-locked"><span className="sa-note">{entryText.colourNotOnSize}</span></td>;
  const key = cellKey(size.id, colour);
  const typed = edit.typed[key] ?? "";
  const now = boxCartons(typed);
  const changed = now !== null && now !== saved;
  const inputId = `mpe-qty-${key}`;
  return (
    <td className={cellClass(problem, changed)}>
      <input id={inputId} className="form-input sa-qty" inputMode="decimal" autoComplete="off" value={typed} {...box}
        aria-label={text.boxLabel(size.size, colour)} aria-invalid={problem !== undefined} aria-describedby={problem ? `${inputId}-problem` : undefined}
        onChange={(event) => edit.type(key, event.target.value)} />
      {changed ? <span className="sa-cell-figures">{text.was(saved > 0 ? dozensText(saved) : "0")}</span> : null}
      {problem ? <span id={`${inputId}-problem`} className="sa-problem" role="alert">⚠ {problem}</span> : null}
    </td>
  );
};

const ChangeList: React.FC<{ changes: readonly EditChange[] }> = ({ changes }) => (
  <div className="mpe-changes" role="status" aria-live="polite">
    <span className="mpe-changes-title">{text.changesTitle}</span>
    {changes.length === 0 ? (
      <span className="mpe-changes-none">{text.noChanges}</span>
    ) : (
      <ul>
        {changes.map((change) => (
          <li key={cellKey(change.articleSizeId, change.color)}>{text.change(change.size, change.color, dozensText(change.fromCartons), dozensText(change.toCartons))}</li>
        ))}
      </ul>
    )}
  </div>
);

export const EditProductionDialog: React.FC<EditProductionDialogProps> = ({ machineName, article, products, onSaved, onClose }) => {
  const edit = useEditProduction(machineName, article);
  const grid = useMemo(() => productionGrid(products, article), [products, article]);
  const saved = useMemo(() => (edit.today?.ok ? savedByCell(edit.today.value) : new Map<string, number>()), [edit.today]);
  const problems = editProblems(edit.typed);
  const changes = editChanges(grid, saved, edit.typed);
  const [reviewing, setReviewing] = useState(false);
  // Read when the confirmation closes, which it does straight after a successful save: a ref, not state, so that
  // close sees it at once and the dialog closes instead of going back to the grid.
  const savedRef = useRef(false);

  if (reviewing) {
    const confirm = async (): Promise<string | null> => {
      const result = await edit.save(changes);
      if (!result.ok) return result.reason;
      savedRef.current = true;
      onSaved(result.value);
      return null;
    };
    return (
      <ConfirmDialog title={text.confirmTitle(article, machineName)} tone="primary"
        facts={changes.map((change) => ({ label: `${change.size} ${change.color}`, value: `${dozensText(change.fromCartons)} → ${dozensText(change.toCartons)}` }))}
        explain={text.confirmExplain} warning={text.confirmWarning} confirmLabel={text.save} busyLabel={text.saving}
        onConfirm={confirm} onClose={() => (savedRef.current ? onClose() : setReviewing(false))} />
    );
  }

  const body = () => {
    if (edit.today === null) return <StateView kind="loading" compact message={text.loading} />;
    if (!edit.today.ok) return <StateView kind="error" compact message={edit.today.reason} />;
    if (grid.sizes.length === 0 || grid.colours.length === 0) return <StateView kind="empty" compact title={text.productsMissing} />;
    return (
      <>
        <p className="mnp-hint">{text.intro}</p>
        <SizeColourGrid label={text.gridLabel(article)} sizeHeader={text.sizeHeader} sizes={grid.sizes} colours={grid.colours}
          onEnter={() => { if (changes.length > 0 && problems.size === 0) setReviewing(true); }}
          renderCell={(size, colour, box) => (
            <Cell size={size} colour={colour} box={box} grid={grid} edit={edit}
              saved={saved.get(cellKey(size.id, colour)) ?? 0} problem={problems.get(cellKey(size.id, colour))} />
          )} />
        <ChangeList changes={changes} />
      </>
    );
  };

  return (
    <Modal title={text.title(article, machineName)} onClose={onClose} wide="xl" className="mpe-dialog"
      footer={<button type="button" className="btn btn-primary" disabled={changes.length === 0 || problems.size > 0} onClick={() => setReviewing(true)}>{text.review}</button>}>
      {body()}
    </Modal>
  );
};
