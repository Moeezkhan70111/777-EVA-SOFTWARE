import React from "react";
import { roundQuantity } from "@erp/domain";
import type { MachineProgramRunRecord, MachineProgramUpperLineRecord } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { QuantityBox } from "./QuantityBox";
import { formatAmount, quantityProblem } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// How many of ONE UPPER this line promises, and the ceiling it is held to.
//
// The same rule the backend applies (@erp/domain checkProgramQuantity) runs as the operator
// types, so a wrong number is explained before it is sent. The box itself is QuantityBox, which
// a fix run's quantity uses too.

interface QuantityCellProps {
  machineId: string;
  programDate: string;
  run: MachineProgramRunRecord;
  line: MachineProgramUpperLineRecord;
  /** The most this line may hold right now: what is free in the store plus its own quantity. */
  limit: number;
  /** True while the store's figure is still being read — the limit is not known yet. */
  loadingLimit: boolean;
  writes: ProgramWrites;
}

export const QuantityCell: React.FC<QuantityCellProps> = ({ machineId, programDate, run, line, limit, loadingLimit, writes }) => (
  <QuantityBox
    saved={String(roundQuantity(line.quantity))}
    ariaLabel={`${copy.machineProgram.changeQuantity} ${line.upperColour} — ${run.article} ${run.size}`}
    // checkProgramQuantity measures `quantity - consumed` against `available`, so `available` is
    // the ceiling with what has already been scanned out taken off it. `limit` is the whole
    // ceiling — the store's free stock with this line's own reservation added back — and that is
    // the figure the Available Stock column shows, so the two can never disagree.
    problemOf={(text) => (loadingLimit ? null : quantityProblem(Number(text), limit, line.consumed, line.unitCode))}
    onSave={(quantity) =>
      writes.saveLine({
        machineId,
        programDate,
        injectorNo: run.injectorNo,
        runId: run.id,
        lineId: line.id,
        itemId: line.itemId,
        quantity,
      })
    }
    note={line.consumed > 0 ? <span className="mpx-qty-note">{copy.machineProgram.taken(formatAmount(line.consumed, line.unitCode))}</span> : null}
  />
);
