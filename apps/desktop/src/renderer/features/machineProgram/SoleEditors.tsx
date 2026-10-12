import React from "react";
import type { MachineShift } from "@erp/domain";
import type { MachineProgramArticleRate, MachineProgramRunRecord, MachineProgramUpperLineRecord } from "../../types/desktopApi";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { copy } from "../../config/copy";
import { AddArticleDialog as AddArticlePanels } from "./AddArticleDialog";
import { formatAmount, injectorTotal } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// What can be done to an injector and to a sole colour's table, each in the same validated flow
// the rest of the feature uses. Nothing here decides anything: every refusal comes back from the
// backend, which re-checks it inside the write lock.
//
// Adding is a dialog rather than a panel that grows inside the card, so the program behind it
// stays readable while the questions are answered — and so an injector with nothing on it has
// one obvious button rather than a form nobody asked for. Both adds are the same dialog
// (AddArticleDialog.tsx); the only difference is whether the sole colour is already settled.

interface AddProps {
  machineId: string;
  programDate: string;
  shift: MachineShift;
  injectorNo: number;
  /** The runs already in scope — a repeated article + size joins its run, never rivals it. */
  runs: MachineProgramRunRecord[];
  /** What the program already pays per article, so the pricing boxes open on what is agreed. */
  articleRates: MachineProgramArticleRate[];
  writes: ProgramWrites;
  onClose: () => void;
}

/**
 * + ADD SOLE COLOR — the whole thing from the top: which sole colour, which article, which size,
 * which uppers and how many of each. Nothing is saved until Add to Program, so closing before
 * that leaves nothing behind.
 */
export const AddSoleColourDialog: React.FC<AddProps> = (props) => (
  <AddArticlePanels
    {...props}
    title={copy.machineProgram.addSoleColour}
    where={copy.machineProgram.injector(props.injectorNo)}
  />
);

/** + ADD ARTICLE — the sole colour is the card's, so the first panel is already answered. */
export const AddArticleDialog: React.FC<AddProps & { colour: string }> = ({ colour, ...props }) => (
  <AddArticlePanels
    {...props}
    fixedColour={colour}
    title={copy.machineProgram.addArticle}
    where={copy.machineProgram.soleLine(colour)}
  />
);

/**
 * Taking one FIX article off a sole.
 *
 * A fix run has no upper lines, so the run IS the article: removing it is what removing an upper
 * is for a normal row. It released nothing when it was made and releases nothing now — its
 * quantity was a plan for the machine, never a promise against the store.
 */
export const RemoveFixRunDialog: React.FC<{ run: MachineProgramRunRecord; writes: ProgramWrites; onClose: () => void }> = ({
  run,
  writes,
  onClose,
}) => (
  <ConfirmDialog
    title={copy.machineProgram.removeArticleTitle}
    facts={[
      { label: copy.machineProgram.article, value: `${run.article} / ${run.size}` },
      {
        label: copy.machineProgram.sole,
        value: copy.machineProgram.fixPair(run.soleColour, run.innerSoleColour ?? ""),
      },
      { label: copy.machineProgram.total, value: formatAmount(run.fixQuantity, run.unitCode) },
    ]}
    explain={copy.machineProgram.removeArticleExplain}
    confirmLabel={copy.machineProgram.removeConfirm}
    onConfirm={async () => {
      const answer = await writes.removeRun(run.id);
      return answer.ok ? null : answer.reason;
    }}
    onClose={onClose}
  />
);

export const RemoveLineDialog: React.FC<{ line: MachineProgramUpperLineRecord; writes: ProgramWrites; onClose: () => void }> = ({
  line,
  writes,
  onClose,
}) => (
  <ConfirmDialog
    title={copy.machineProgram.removeUpperTitle}
    facts={[
      { label: copy.machineProgram.upper, value: `${line.upperColour} · ${line.subCategoryName}` },
      { label: copy.machineProgram.total, value: formatAmount(line.quantity, line.unitCode) },
    ]}
    explain={copy.machineProgram.removeUpperExplain}
    confirmLabel={copy.machineProgram.removeConfirm}
    onConfirm={async () => {
      const answer = await writes.removeLine(line.id);
      return answer.ok ? null : answer.reason;
    }}
    onClose={onClose}
  />
);

/**
 * Taking a whole sole colour off an injector.
 *
 * A colour may be several sole runs, and each run is its own saved transaction — the backend
 * has no "remove a colour" of its own, because a colour is not a thing it stores. They are
 * removed one at a time and the first refusal stops the rest, which is what happens when
 * something on a run has already been scanned out of the store: that run is history and stays.
 * Whatever was removed before the refusal stays removed, and the dialog says which run stopped
 * it so nobody is left guessing.
 */
export const RemoveSoleColourDialog: React.FC<{
  colour: string;
  runs: MachineProgramRunRecord[];
  writes: ProgramWrites;
  onClose: () => void;
}> = ({ colour, runs, writes, onClose }) => {
  const total = injectorTotal(runs);
  return (
    <ConfirmDialog
      title={copy.machineProgram.removeSoleTitle}
      facts={[
        { label: copy.machineProgram.sole, value: copy.machineProgram.soleLine(colour) },
        { label: copy.machineProgram.article, value: runs.map((run) => `${run.article} / ${run.size}`).join(", ") },
        { label: copy.machineProgram.total, value: formatAmount(total.quantity, total.unitCode) },
      ]}
      explain={copy.machineProgram.removeSoleExplain}
      confirmLabel={copy.machineProgram.removeConfirm}
      onConfirm={async () => {
        for (const run of runs) {
          const answer = await writes.removeRun(run.id);
          if (!answer.ok) return `${run.article} ${run.size}: ${answer.reason}`;
        }
        return null;
      }}
      onClose={onClose}
    />
  );
};
