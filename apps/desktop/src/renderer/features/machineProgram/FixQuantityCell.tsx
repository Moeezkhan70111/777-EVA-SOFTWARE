import React from "react";
import { roundQuantity, type MachineShift } from "@erp/domain";
import type { MachineProgramRunRecord } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { QuantityBox } from "./QuantityBox";
import { fixQuantityProblem } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// How many of a FIX article are to be made — typed on the run, because there is no upper line
// for it to live on.
//
// It is held to no ceiling: a fix run reserves nothing, so there is no store figure it could ask
// for more of than there is. Saving it is the same write that created it
// (SaveMachineProgramFixRunUseCase), which changes the program's run for this article rather than
// adding a rival one (a fix run has no injector), so the soles are sent back exactly as they stand.

interface FixQuantityCellProps {
  machineId: string;
  programDate: string;
  shift: MachineShift;
  run: MachineProgramRunRecord;
  writes: ProgramWrites;
}

export const FixQuantityCell: React.FC<FixQuantityCellProps> = ({ machineId, programDate, shift, run, writes }) => (
  <QuantityBox
    saved={String(roundQuantity(run.fixQuantity))}
    ariaLabel={`${copy.machineProgram.changeQuantity} ${run.article} ${run.size}`}
    problemOf={(text) => fixQuantityProblem(text)}
    onSave={(quantity) =>
      writes.saveFixRun({
        machineId,
        programDate,
        shift,
        runId: run.id,
        soleColour: run.soleColour,
        innerSoleColour: run.innerSoleColour ?? "",
        articleSizeId: run.articleSizeId,
        quantity,
      })
    }
  />
);
