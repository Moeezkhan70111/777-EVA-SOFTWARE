import React, { useCallback, useMemo, useState } from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { MachineRecord } from "../../types/desktopApi";
import { MachinePicker } from "../machineProgram/MachinePicker";
import { useMachines } from "../machineProgram/useCartonProgram";
import { useProductionDay, useTodayMark } from "../productionDay/useProductionDay";
import { CartonCloudOffNotice } from "../sync/CartonCloudOffNotice";
import { ArticleEntryCard, savedKey } from "./ArticleEntryCard";
import { listedFor } from "./manualProductionDraft";
import { ManualProductionList } from "./ManualProductionList";
import { ProductionListCard } from "./ProductionListCard";
import { TodayStrip } from "./TodayStrip";
import { useArticleEntry } from "./useArticleEntry";
import { useManualProductionDay, useProductChoices, useVoidManualProduction } from "./useManualProduction";
import { useProductionList } from "./useProductionList";

// MANUAL PRODUCTION, A PAGE OF ITS OWN (owner, 14 Nov 2026; it was a QR Generator tab):
//
//   TODAY · 14 Nov   12 dozen saved · 4 entries        [ ○ Production not added ]   [ ✓ Complete today's production ]
//   ① Machine   [● MACHINE 1] [ MACHINE 2] [ MACHINE 3]
//   ② Article   [ SK6 ▾ ]   sizes down, colours across, a box in each           [ Clear ] [ Add to list ]
//   ③ Production to save   MACHINE 1 · 12 dozen  (lines, Remove)   MACHINE 2 · …     [ Clear list ] [ Save production ]
//   Manual production today   Production: each machine, each article as a matrix, Edit, Download PDF;
//                             Entries: the saved entries, Void
//
// Choose a machine, an article, type every size and colour at once, Add to list; the next article, the next
// machine; then Save, which records every line together or none (docs/48). When every machine is in, "Complete
// today's production" marks the day, and Carton Stock turns green on every computer.

const text = copy.manualProduction;

interface ManualProductionPageProps {
  onOpenDaily?: () => void;
  onSetUpMachines?: () => void;
}

export const ManualProductionPage: React.FC<ManualProductionPageProps> = ({ onOpenDaily, onSetUpMachines }) => {
  const machines = useMachines(copy.machinePicker.failed);
  const [machine, setMachine] = useState<MachineRecord | null>(null);
  const products = useProductChoices();
  const day = useManualProductionDay();
  // Today's production per machine and article: the Production section's matrices (TodayProduction).
  const production = useProductionDay();
  const today = useTodayMark();
  const reloadDay = day.reload;
  const reloadProduction = production.reload;
  const onSaved = useCallback(() => {
    void reloadDay();
    void reloadProduction();
  }, [reloadDay, reloadProduction]);
  const list = useProductionList(onSaved);
  const entry = useArticleEntry(products, machine, list.add);
  const voidEntry = useVoidManualProduction(onSaved);

  const savedToday = useMemo(
    () => new Map((day.page?.summary ?? []).map((line) => [savedKey(line.article, line.size, line.color), line.cartons])),
    [day.page]
  );
  const listed = machine ? listedFor(list.lines, machine.id) : new Map<string, number>();

  const productsBody = () => {
    if (products.loading && products.value.length === 0) return <StateView kind="loading" compact message={text.productsLoading} />;
    if (products.error) return <StateView kind="error" compact message={products.error} onRetry={() => void products.reload()} />;
    if (products.value.length === 0) return <StateView kind="empty" compact title={text.noProductsTitle} hint={text.noProductsHint} />;
    return <ArticleEntryCard machine={machine} products={products.value} entry={entry} savedToday={savedToday} listed={listed} />;
  };

  return (
    <div className="page-stack mnp-page">
      <CartonCloudOffNotice />
      <TodayStrip today={today} savedCartons={day.page?.totalCartons ?? null} savedEntries={day.page?.totalEntries ?? 0}
        unsavedLines={list.lines.length} onOpenDaily={onOpenDaily} />
      <div className="mnp-step">
        <MachinePicker machines={machines} selectedId={machine?.id ?? null} onSelect={setMachine} onSetUpMachines={onSetUpMachines} step={1} />
      </div>
      {productsBody()}
      <ProductionListCard lines={list.lines} saving={list.saving} outcome={list.outcome} onRemove={list.remove} onClear={list.clear} onSave={list.save} />
      <ManualProductionList day={day} onVoid={voidEntry} production={production} products={products.value} onEdited={onSaved} />
    </div>
  );
};
