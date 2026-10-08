import React, { useState } from "react";
import type { MachineShift } from "@erp/domain";
import type {
  MachineProgramMaterial,
  MachineProgramRunHeader,
  MachineProgramRunRecord,
  MachineProgramUpperLineRecord,
  MachineProgramWriteResult,
} from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { QuantityEntry } from "./QuantityEntry";
import { UpperPicker } from "./UpperPicker";
import { upperKind } from "./machineProgram";
import { useUppers } from "./useMachineProgramData";
import type { ProgramWrites } from "./useProgramWrites";

// The two ways an upper gets onto a sole: choosing one and saying how many (AddUpper), and
// changing how many of one already there (ChangeUpperQuantity). Both end in the same QuantityEntry
// and the same save, so the operator meets one way of entering a quantity everywhere.

interface AddUpperProps {
  machineId: string;
  programDate: string;
  /** The shift the date's program is made with, when this upper is the first thing on it. */
  shift: MachineShift;
  injectorNo: number;
  /** The saved run the upper goes on — or null with `header` for the first upper of a new one. */
  runId: string | null;
  header: MachineProgramRunHeader | null;
  article: string;
  size: string;
  articleSizeId: string;
  takenItemIds: ReadonlySet<string>;
  writes: ProgramWrites;
  onSaved: (result: MachineProgramWriteResult) => void;
  onCancel: () => void;
}

/** CHOOSE UPPER COLOUR → HOW MANY? → ADD. */
export const AddUpper: React.FC<AddUpperProps> = (props) => {
  const [chosen, setChosen] = useState<MachineProgramMaterial | null>(null);

  if (!chosen) {
    return (
      <>
        <div className="mp-step-head mp-step-head--spaced">
          <button type="button" className="btn btn-ghost mp-back-step" onClick={props.onCancel}>
            {copy.machineProgram.back}
          </button>
          <h3 className="mp-question">{copy.machineProgram.stepUpper}</h3>
        </div>
        <UpperPicker
          machineId={props.machineId}
          articleSizeId={props.articleSizeId}
          article={props.article}
          size={props.size}
          takenItemIds={props.takenItemIds}
          stockVersion={props.writes.stockVersion}
          onChoose={setChosen}
        />
      </>
    );
  }

  return (
    <QuantityEntry
      title={`${copy.machineProgram.upperLine(chosen.colour)} · ${upperKind(chosen)}`}
      unitCode={chosen.unitCode}
      limit={chosen.available}
      submitLabel={copy.machineProgram.add}
      onCancel={() => setChosen(null)}
      onSubmit={async (quantity) => {
        const answer = await props.writes.saveLine({
          machineId: props.machineId,
          programDate: props.programDate,
          shift: props.shift,
          injectorNo: props.injectorNo,
          runId: props.runId,
          run: props.runId ? null : props.header,
          itemId: chosen.itemId,
          quantity,
        });
        if (!answer.ok) return answer.reason;
        props.onSaved(answer.result);
        return null;
      }}
    />
  );
};

interface ChangeUpperQuantityProps {
  machineId: string;
  programDate: string;
  run: MachineProgramRunRecord;
  line: MachineProgramUpperLineRecord;
  writes: ProgramWrites;
  onDone: () => void;
}

/**
 * A line's new quantity is limited by what is free in the store PLUS what the line already holds —
 * the store's figure counts the line's own quantity as taken.
 */
export const ChangeUpperQuantity: React.FC<ChangeUpperQuantityProps> = ({ machineId, programDate, run, line, writes, onDone }) => {
  const uppers = useUppers(machineId, run.articleSizeId, writes.stockVersion);
  if (uppers.loading && uppers.value.length === 0) return <StateView kind="loading" compact />;
  if (uppers.error) return <StateView kind="error" compact message={uppers.error} onRetry={() => void uppers.reload()} />;

  const material = uppers.value.find((candidate) => candidate.itemId === line.itemId);
  const limit = (material?.available ?? 0) + line.quantity;

  return (
    <QuantityEntry
      title={`${copy.machineProgram.upperLine(line.upperColour)} · ${line.subCategoryName}`}
      unitCode={line.unitCode}
      limit={limit}
      consumed={line.consumed}
      initial={line.quantity}
      submitLabel={copy.machineProgram.saveChanges}
      onCancel={onDone}
      onSubmit={async (quantity) => {
        const answer = await writes.saveLine({
          machineId,
          programDate,
          injectorNo: run.injectorNo,
          runId: run.id,
          lineId: line.id,
          itemId: line.itemId,
          quantity,
        });
        if (!answer.ok) return answer.reason;
        onDone();
        return null;
      }}
    />
  );
};
