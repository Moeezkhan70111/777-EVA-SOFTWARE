import React from "react";
import type { MachineShift } from "@erp/domain";
import type { MachineProgramRunRecord, MachineProgramUpperLineRecord } from "../../types/desktopApi";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { Modal } from "../../components/shared/Modal";
import { copy } from "../../config/copy";
import { RunBuilder } from "./RunBuilder";
import { AddUpper } from "./UpperEditors";
import { formatAmount, injectorTotal, runForArticleSize, type RunStep } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// What can be done to an injector and to a sole colour's table, each in the same validated flow
// the rest of the feature uses. Nothing here decides anything: every refusal comes back from the
// backend, which re-checks it inside the write lock.
//
// Adding is a dialog rather than a panel that grows inside the card, so the program behind it
// stays readable while the questions are answered — and so an injector with nothing on it has
// one obvious button rather than a form nobody asked for.

/** The colour is the card's, so adding an article asks only the two questions below it. */
const ADD_ARTICLE_STEPS: readonly RunStep[] = ["article", "size"];

interface AddProps {
  machineId: string;
  programDate: string;
  shift: MachineShift;
  injectorNo: number;
  /** The runs already in scope — a repeated article + size joins its run, never rivals it. */
  runs: MachineProgramRunRecord[];
  writes: ProgramWrites;
  onClose: () => void;
}

/**
 * + ADD SOLE COLOR — the whole thing from the top: which sole colour, which article, which size,
 * which upper and how many. The first upper is what saves it, so closing before that leaves
 * nothing behind.
 */
export const AddSoleColourDialog: React.FC<AddProps> = (props) => (
  <Modal title={copy.machineProgram.addSoleColour} subtitle={copy.machineProgram.injector(props.injectorNo)} wide onClose={props.onClose}>
    <RunBuilder
      initialDraft={{ soleColour: null, article: null, articleSizeId: null, size: null }}
      onExit={props.onClose}
      complete={(draft, back) => {
        if (!draft.soleColour || !draft.articleSizeId || !draft.article || !draft.size) return null;
        return <Finish {...props} colour={draft.soleColour} article={draft.article} size={draft.size} articleSizeId={draft.articleSizeId} onBack={back} />;
      }}
    />
  </Modal>
);

/** + ADD ARTICLE — the sole colour is the card's, so only the article and the size are asked. */
export const AddArticleDialog: React.FC<AddProps & { colour: string }> = ({ colour, ...props }) => (
  <Modal title={copy.machineProgram.addArticle} subtitle={copy.machineProgram.soleLine(colour)} wide onClose={props.onClose}>
    <RunBuilder
      initialDraft={{ soleColour: colour, article: null, articleSizeId: null, size: null }}
      asks={ADD_ARTICLE_STEPS}
      onExit={props.onClose}
      complete={(draft, back) => {
        if (!draft.articleSizeId || !draft.article || !draft.size) return null;
        return <Finish {...props} colour={colour} article={draft.article} size={draft.size} articleSizeId={draft.articleSizeId} onBack={back} />;
      }}
    />
  </Modal>
);

/**
 * The last two questions, shared by both dialogs: which upper, and how many of it.
 *
 * An article + size already programmed in this colour joins its run rather than standing beside
 * it as a rival — a sole run IS the colour, the article and the size.
 */
const Finish: React.FC<
  AddProps & { colour: string; article: string; size: string; articleSizeId: string; onBack: () => void }
> = ({ colour, article, size, articleSizeId, runs, onBack, onClose, ...rest }) => {
  const existing = runForArticleSize(runs, colour, articleSizeId);
  return (
    <AddUpper
      machineId={rest.machineId}
      programDate={rest.programDate}
      shift={rest.shift}
      injectorNo={rest.injectorNo}
      runId={existing?.id ?? null}
      header={existing ? null : { soleColour: colour, articleSizeId }}
      article={article}
      size={size}
      articleSizeId={articleSizeId}
      takenItemIds={new Set((existing?.lines ?? []).map((line) => line.itemId))}
      writes={rest.writes}
      onSaved={onClose}
      onCancel={onBack}
    />
  );
};

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
