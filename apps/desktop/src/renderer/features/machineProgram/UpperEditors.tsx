import React from "react";
import type { MachineProgramRunRecord, MachineProgramUpperLineRecord } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { QuantityEntry } from "./QuantityEntry";
import { upperRunInjector } from "./machineProgram";
import { useUppers } from "./useMachineProgramData";
import type { ProgramWrites } from "./useProgramWrites";

// Changing how many of an upper a saved line holds. Getting an upper ONTO a sole is the Add
// Article dialog's job (AddArticleDialog.tsx); this is the one that is already there, re-asked
// through the same QuantityEntry, so a quantity is typed the same way everywhere.

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
          injectorNo: upperRunInjector(run),
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
