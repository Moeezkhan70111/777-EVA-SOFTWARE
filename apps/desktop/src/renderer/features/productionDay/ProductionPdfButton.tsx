import React from "react";
import type { ProductionDayView } from "@erp/domain";
import { copy } from "../../config/copy";
import type { ProductionPdf } from "./useProductionPdf";

// One "Download PDF" button, for the whole day (machineName null) or one machine of it. Shared by the Daily
// Production page and the Manual Production page (R1). While one PDF is being made, every button waits.

const text = copy.productionReport;

interface ProductionPdfButtonProps {
  day: ProductionDayView;
  machineName: string | null;
  pdf: ProductionPdf;
  /** "btn-secondary" beside other controls; "btn-ghost btn-sm" inside a section heading. */
  className?: string;
}

export const ProductionPdfButton: React.FC<ProductionPdfButtonProps> = ({ day, machineName, pdf, className = "btn btn-secondary" }) => {
  const label = machineName === null ? text.downloadDay : text.downloadMachine(machineName);
  return (
    <button type="button" className={`${className} pd-pdf-button`} disabled={pdf.making !== null || day.totalCartons === 0}
      aria-busy={pdf.making === (machineName ?? "")} onClick={() => void pdf.download(day, machineName)}>
      <span aria-hidden="true">⬇</span> {label}
    </button>
  );
};
