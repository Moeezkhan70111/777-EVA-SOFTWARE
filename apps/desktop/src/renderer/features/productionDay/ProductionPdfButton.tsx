import React from "react";
import type { ProductionDayView } from "@erp/domain";
import { copy } from "../../config/copy";
import type { ProductionPdf } from "./useProductionPdf";

// One "Download PDF" button, for the whole day (machineName null) or one machine of it. Shared by the Daily
// Production page and the Manual Production page (R1). While one PDF is being made, every button waits.
// A quiet secondary action: white, a grey-blue border, blue icon and "Export PDF" (owner, 16 Nov 2026). A machine's
// button says which machine to a screen reader, starting with the words on screen.

const text = copy.productionReport;

interface ProductionPdfButtonProps {
  day: ProductionDayView;
  machineName: string | null;
  pdf: ProductionPdf;
  /** "btn-secondary" beside other controls; "btn-ghost btn-sm" inside a section heading. */
  className?: string;
}

export const ProductionPdfButton: React.FC<ProductionPdfButtonProps> = ({ day, machineName, pdf, className = "btn btn-secondary" }) => {
  const name = machineName === null ? undefined : text.downloadMachine(machineName);
  return (
    <button type="button" className={`${className} pd-pdf-button`} disabled={pdf.making !== null || day.totalCartons === 0}
      aria-label={name} aria-busy={pdf.making === (machineName ?? "")} onClick={() => void pdf.download(day, machineName)}>
      <svg className="pd-pdf-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5M4 14.5V16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {text.downloadDay}
    </button>
  );
};
