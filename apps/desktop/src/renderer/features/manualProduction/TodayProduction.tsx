import React, { useState } from "react";
import type { ProductionDayView } from "@erp/domain";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { PolledRead } from "../../hooks/usePolledRead";
import { useOptionalNotifications } from "../../state/NotificationsContext";
import { dozenFigure } from "../cartonStock/CartonMatrix";
import { CartonMatrixList } from "../cartonStock/CartonMatrixList";
import { ProductionPdfButton } from "../productionDay/ProductionPdfButton";
import { useProductionPdf } from "../productionDay/useProductionPdf";
import { EditProductionDialog } from "./EditProductionDialog";
import type { ProductChoice } from "./productChoices";

// TODAY'S PRODUCTION, AS A MATRIX (owner, 14 Nov 2026): instead of a line per size and colour,
//
//   [ ⬇ Download PDF ]
//   MACHINE 1 · 69 dozen                                            [ ⬇ Download MACHINE 1 PDF ]
//   ┌ SK12  [Edit] ┬ Size │ BLACKBLUE │ BLACKRED │ GREEN │ Total ┐
//   │              │ 7/10 │     1     │    2     │  54   │  57   │
//   │              │ 4/6  │     2     │   10     │   -   │  12   │
//   │              │ Total│     3     │   12     │  54   │  69   │
//
// one card per article for each machine (CartonMatrixList, the same cards as Carton Stock and Daily Production).
// Edit opens the article's grid with today's figures in it (EditProductionDialog). Every figure is the main
// process's (productionDayView); voided entries are left out.

const text = copy.productionEdit;

interface TodayProductionProps {
  production: PolledRead<ProductionDayView>;
  products: readonly ProductChoice[];
  /** A change was saved: the page reads its figures again. */
  onEdited: () => void;
}

const MachineSection: React.FC<{ day: ProductionDayView; index: number; pdf: ReturnType<typeof useProductionPdf>; onEdit: (machine: string, article: string) => void }> = ({ day, index, pdf, onEdit }) => {
  const machine = day.machines[index];
  const headingId = `mpe-machine-${String(index)}`;
  return (
    <section className="mpe-machine" aria-labelledby={headingId}>
      <div className="mpe-machine-head">
        <h3 id={headingId} className="mpe-machine-name">{copy.productionReport.machineHeading(machine.machineName, dozenFigure(machine.cartons))}</h3>
        <ProductionPdfButton day={day} machineName={machine.machineName} pdf={pdf} className="btn btn-ghost btn-sm" />
      </div>
      <CartonMatrixList articles={machine.articles} tableLabel={copy.productionDay.tableLabel}
        renderAction={(article) => (
          <button type="button" className="btn btn-secondary btn-sm" aria-label={text.editLabel(article.article, machine.machineName)}
            onClick={() => onEdit(machine.machineName, article.article)}>
            {text.edit}
          </button>
        )} />
    </section>
  );
};

export const TodayProduction: React.FC<TodayProductionProps> = ({ production, products, onEdited }) => {
  const pdf = useProductionPdf();
  const notices = useOptionalNotifications();
  const [editing, setEditing] = useState<{ machine: string; article: string } | null>(null);
  const day = production.value;

  if (!day && production.error) return <StateView kind="error" compact message={production.error} onRetry={() => void production.reload()} />;
  if (!day) return <StateView kind="loading" compact message={text.productionLoading} />;
  if (day.machines.length === 0) return <StateView kind="empty" compact title={copy.manualProduction.emptyTitle} hint={copy.manualProduction.emptyHint} />;

  const saved = (changed: number) => {
    notices?.push("success", text.savedTitle, changed > 0 ? text.savedBody(changed) : text.unchangedBody);
    setEditing(null);
    onEdited();
  };

  return (
    <div className="carton-stock-page mpe-production">
      <div className="mpe-day-actions">
        <ProductionPdfButton day={day} machineName={null} pdf={pdf} />
      </div>
      {day.machines.map((machine, index) => (
        <MachineSection key={machine.machineName} day={day} index={index} pdf={pdf} onEdit={(name, article) => setEditing({ machine: name, article })} />
      ))}
      {editing ? (
        <EditProductionDialog machineName={editing.machine} article={editing.article} products={products} onSaved={saved} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
};
