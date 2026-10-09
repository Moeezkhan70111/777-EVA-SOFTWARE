import { MACHINE_INJECTORS, formatShiftRange } from "@erp/domain";
import type { MachineProgramRecord } from "../../types/desktopApi";
import { openReport } from "../../utils/reportDocument";
import { formatDate, formatLongDate } from "../../utils/dates";
import { copy } from "../../config/copy";
import { formatAmount, formatNumber, injectorRuns, injectorTotal, statusLabel } from "./machineProgram";

// Printing a machine program.
//
// Built from the SAVED program, never from what is on screen: the sheet that goes to the machine
// has to be the same document the store scans against. It goes through the existing report
// printer (utils/reportDocument → platform/print), so it lands on the company letterhead like
// every other print-out, and "PDF" is the print dialog's Save as PDF — no second print path, no
// PDF library (R1, R4, R7).
//
// One row per upper colour, injector by injector: the sole colour, the article and size, then the
// upper and how much of it. The storekeeper brings that upper from wherever it is standing — the
// program does not name a supplier, so the sheet does not print one.

export const printMachineProgram = (program: MachineProgramRecord, preparedBy?: string | null): boolean => {
  const rows = MACHINE_INJECTORS.flatMap((injectorNo) =>
    injectorRuns(program, injectorNo).flatMap((run) =>
      run.lines.map((line) => [
        copy.machineProgram.injector(injectorNo),
        run.soleColour,
        run.article,
        run.size,
        line.upperColour,
        line.subCategoryName,
        formatNumber(line.quantity),
        line.unitCode ?? "",
      ])
    )
  );

  const injectorTotals = MACHINE_INJECTORS.map((injectorNo) => ({ injectorNo, total: injectorTotal(injectorRuns(program, injectorNo)) }))
    .filter(({ total }) => total.quantity > 0)
    .map(({ injectorNo, total }) => ({ label: copy.machineProgram.injector(injectorNo), value: formatAmount(total.quantity, total.unitCode) }));

  return openReport({
    title: copy.machineProgram.title,
    filters: [
      { label: "Program", value: program.code },
      { label: "Machine", value: program.machineName },
      { label: copy.machineProgram.machineContractor, value: program.contractorName },
      // Programs made before a machine had two contractors have no packer to name, and the
      // sheet says so rather than printing a blank.
      { label: copy.machineProgram.packingContractor, value: program.packingContractorName ?? copy.machineProgram.noPackingContractorYet },
      { label: copy.machineProgram.programDate, value: formatLongDate(program.programDate) },
      {
        label: copy.machineProgram.shiftTime,
        value: formatShiftRange({ startMinute: program.shiftStartMinute, endMinute: program.shiftEndMinute }),
      },
      { label: "Status", value: statusLabel(program.displayStatus) },
    ],
    columns: [
      { label: "Injector" },
      { label: copy.machineProgram.soleColour },
      { label: copy.machineProgram.article },
      { label: copy.machineProgram.size },
      { label: "Upper colour" },
      { label: "Upper" },
      { label: "Quantity", numeric: true },
      { label: "Unit" },
    ],
    rows,
    totals: [...injectorTotals, { label: copy.machineProgram.machineTotal, value: formatAmount(program.totalQuantity, program.unitCode) }],
    footnote:
      `Prepared by ${preparedBy?.trim() || program.createdBy || "—"} · ${formatDate(program.createdAt)}. ` +
      copy.machineProgram.reservationNote,
    emptyMessage: copy.machineProgram.noProgramYet,
  });
};
