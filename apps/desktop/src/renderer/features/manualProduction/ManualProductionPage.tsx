import React, { useCallback, useEffect, useMemo, useState } from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { MachineRecord } from "../../types/desktopApi";
import { MachineDialog } from "../machineProgram/MachineDialog";
import { MachinePicker } from "../machineProgram/MachinePicker";
import { useCanChangeContractors } from "../machineProgram/useCanChangeContractors";
import { useNotifications } from "../../state/NotificationsContext";
import { useMachines } from "../machineProgram/useCartonProgram";
import { useProductionDay, useTodayMark } from "../productionDay/useProductionDay";
import { CartonCloudOffNotice } from "../sync/CartonCloudOffNotice";
import { ArticleEntryCard, savedKey } from "./ArticleEntryCard";
import { dayProgress } from "./dayProgress";
import { dozensText, listedFor } from "./manualProductionDraft";
import { ManualProductionList } from "./ManualProductionList";
import { ProductionListCard } from "./ProductionListCard";
import { TodayStrip } from "./TodayStrip";
import { useArticleEntry } from "./useArticleEntry";
import { useManualProductionDay, useProductChoices, useVoidManualProduction } from "./useManualProduction";
import { useProductionList } from "./useProductionList";
import { useCanAddColour } from "../../hooks/useCanAddColour";

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
//
// The UI/UX pass (owner, 25 Nov 2026): the strip says how many machines are in and which are still to add (goal
// gradient, Zeigarnik); each machine card says whether it is in (recognition over recall); once every machine is in,
// the list sends the operator back to Complete (peak-end). Every figure is the main process's.
//
// A machine's contractors are changed from its card (owner, 25 Nov 2026): the pencil opens the same dialog as Machine
// Program (MachineDialog), for whoever may change them (useCanChangeContractors). As there, the change applies from
// the machine's next program; production already entered on today's program keeps the pair it was opened with.

const text = copy.manualProduction;

interface ManualProductionPageProps {
  onOpenDaily?: () => void;
  onSetUpMachines?: () => void;
  /** Opens the Add Party page (from the contractors dialog); absent when this user may not open it. */
  onAddParty?: () => void;
}

export const ManualProductionPage: React.FC<ManualProductionPageProps> = ({ onOpenDaily, onSetUpMachines, onAddParty }) => {
  const machines = useMachines(copy.machinePicker.failed);
  const [machine, setMachine] = useState<MachineRecord | null>(null);
  const [editingMachine, setEditingMachine] = useState<MachineRecord | null>(null);
  const canChangeContractors = useCanChangeContractors();
  const { push } = useNotifications();
  // The machines read again (new contractors): the chosen one stays chosen, with its new figures.
  useEffect(() => {
    setMachine((current) => (current ? machines.rows.find((row) => row.id === current.id) ?? null : null));
  }, [machines.rows]);
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
  // Adding a colour to an article: the one rule every quantity-by-colour page asks; after it, the products are read again.
  const canAddColour = useCanAddColour();
  const reloadProducts = products.reload;
  const onColourAdded = useCallback(() => { void reloadProducts(); }, [reloadProducts]);

  const savedToday = useMemo(
    () => new Map((day.page?.summary ?? []).map((line) => [savedKey(line.article, line.size, line.color), line.cartons])),
    [day.page]
  );
  const listed = machine ? listedFor(list.lines, machine.id) : new Map<string, number>();
  const progress = useMemo(
    () => (machines.rows.length > 0 && production.value ? dayProgress(machines.rows, production.value.machines) : null),
    [machines.rows, production.value]
  );
  const machineNotes = useMemo(() => {
    if (!progress) return undefined;
    // Only the machines that are in say so; the tile at the top names the ones still to add (no repeating).
    return new Map([...progress.cartonsByMachine].map(([id, cartons]) => [id, copy.manualProductionPage.machineSaved(dozensText(cartons))] as const));
  }, [machines.rows, progress]);
  const allIn = progress !== null && progress.missing.length === 0 && progress.done.length > 0 && today.value?.mark == null;

  const productsBody = () => {
    if (products.loading && products.value.length === 0) return <StateView kind="loading" compact message={text.productsLoading} />;
    if (products.error) return <StateView kind="error" compact message={products.error} onRetry={() => void products.reload()} />;
    if (products.value.length === 0) return <StateView kind="empty" compact title={text.noProductsTitle} hint={text.noProductsHint} />;
    return <ArticleEntryCard machine={machine} products={products.value} entry={entry} savedToday={savedToday} listed={listed} canAddColour={canAddColour} onColourAdded={onColourAdded} />;
  };

  return (
    <div className="page-stack mnp-page">
      <CartonCloudOffNotice />
      <TodayStrip today={today} savedCartons={day.page?.totalCartons ?? null} savedEntries={day.page?.totalEntries ?? 0}
        unsavedLines={list.lines.length} onOpenDaily={onOpenDaily} progress={progress} />
      <div className="mnp-step">
        <MachinePicker machines={machines} selectedId={machine?.id ?? null} onSelect={setMachine} onSetUpMachines={onSetUpMachines} step={1} notes={machineNotes} showHint={false}
          onEditContractors={canChangeContractors ? setEditingMachine : undefined} />
      </div>
      {productsBody()}
      <ProductionListCard lines={list.lines} saving={list.saving} outcome={list.outcome} allIn={allIn} onRemove={list.remove} onClear={list.clear} onSave={list.save} />
      {editingMachine ? (
        <MachineDialog machine={editingMachine} onAddParty={onAddParty} onClose={() => setEditingMachine(null)}
          onSaved={(title, body) => { push("success", title, body); setEditingMachine(null); void machines.reload(); }} />
      ) : null}
      <ManualProductionList day={day} onVoid={voidEntry} production={production} products={products.value} onEdited={onSaved} onColourAdded={onColourAdded} />
    </div>
  );
};
