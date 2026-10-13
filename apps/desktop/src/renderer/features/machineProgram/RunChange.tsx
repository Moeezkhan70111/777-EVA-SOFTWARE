import React, { useState } from "react";
import { isFixRun } from "@erp/domain";
import type { MachineProgramRunRecord } from "../../types/desktopApi";
import { Modal } from "../../components/shared/Modal";
import { copy } from "../../config/copy";
import { RunBuilder } from "./RunBuilder";
import { draftFromRun, type RunDraft } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// Changing a saved sole run: the same three questions it was built with, already answered, each
// with its own Change. The sole colour changes freely. A different article or size takes the
// uppers off — they belong to the old one — so the save panel says so before anything moves.

interface RunChangeDialogProps {
  run: MachineProgramRunRecord;
  writes: ProgramWrites;
  onClose: () => void;
}

export const RunChangeDialog: React.FC<RunChangeDialogProps> = ({ run, writes, onClose }) => (
  <Modal
    title={copy.machineProgram.editSoleTitle}
    subtitle={`${copy.machineProgram.soleLine(run.soleColour)} · ${run.article} ${run.size}`}
    wide
    onClose={onClose}
  >
    <RunBuilder
      initialDraft={draftFromRun(run)}
      kind={isFixRun(run) ? "FIX" : "UPPER"}
      onExit={onClose}
      complete={(draft, back) => <SaveRunChange run={run} draft={draft} writes={writes} onBack={back} onDone={onClose} />}
    />
  </Modal>
);

const SaveRunChange: React.FC<{ run: MachineProgramRunRecord; draft: RunDraft; writes: ProgramWrites; onBack: () => void; onDone: () => void }> = ({
  run,
  draft,
  writes,
  onBack,
  onDone,
}) => {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const articleChanged = draft.articleSizeId !== run.articleSizeId;

  const save = async () => {
    if (!draft.soleColour || !draft.articleSizeId) return;
    setSaving(true);
    setProblem(null);
    const answer = await writes.changeRun(run.id, { soleColour: draft.soleColour, articleSizeId: draft.articleSizeId });
    setSaving(false);
    if (answer.ok) onDone();
    else setProblem(answer.reason);
  };

  return (
    <section className="mp-panel">
      {articleChanged && run.lines.length > 0 ? (
        <p className="mp-warning" role="status">
          ⚠ {copy.machineProgram.articleChangeWarning(run.lines.length, run.article, run.size)}
        </p>
      ) : null}
      {problem ? (
        <p className="mp-problem" role="alert">
          ⚠ {problem}
        </p>
      ) : null}
      <div className="mp-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          {copy.machineProgram.back}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          {copy.common.cancel}
        </button>
        <button type="button" className="btn btn-primary btn-lg" disabled={saving} onClick={() => void save()}>
          {saving ? copy.machineProgram.saving : copy.machineProgram.saveChanges}
        </button>
      </div>
    </section>
  );
};
