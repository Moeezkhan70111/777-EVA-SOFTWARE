import React, { useCallback } from "react";
import { formatQuantityInDozens } from "@erp/domain";
import { copy } from "../../config/copy";
import type { MachineRecord } from "../../types/desktopApi";
import { ManualProductionForm } from "./ManualProductionForm";
import { ManualProductionList } from "./ManualProductionList";
import { useManualProductionDay, useProductChoices, useSaveManualProduction } from "./useManualProduction";

// MANUAL PRODUCTION — a QR Generator tab, beside Receive Production (owner, 2026-10-14):
//
//   Manual Production                                         RECORDED TODAY  20 cartons · 10 DZN
//   Record cartons produced without scanning. They go into store stock and the contractor ledger.
//   ┌ Record production ────────────────┐  ┌ Manual production today ─────────────────────┐
//   │ Article  Size  Colour  Dozens     │  │ [ Details ] [ Summary ]                      │
//   │ [ Save production ]               │  │ …                                            │
//   └───────────────────────────────────┘  └──────────────────────────────────────────────┘
//
// For when cartons are not scanned: the operator types what was made. The machine comes from the
// workspace's picker, and each Save joins that machine's program for today, adds the cartons to
// store stock and puts the work on its machine and packing contractors' ledgers — all decided and
// written by the main process in one transaction. Nothing is recorded by opening or leaving the tab.

const text = copy.manualProduction;

export const ManualProductionTab: React.FC<{ machine: MachineRecord | null }> = ({ machine }) => {
  const day = useManualProductionDay();
  const products = useProductChoices();
  const reloadDay = day.reload;
  const onSaved = useCallback(() => void reloadDay(), [reloadDay]);
  const saving = useSaveManualProduction(onSaved);
  const total = day.page?.totalCartons ?? null;

  return (
    <div className="rp-tab">
      <header className="rp-head">
        <div>
          <h2 className="rp-title">{text.title}</h2>
          <p className="rp-subtitle">{text.subtitle}</p>
        </div>
        <div className="rp-count" aria-live="polite">
          <span className="rp-count-label">{text.countLabel}</span>
          <strong>{total === null ? "—" : copy.receiveProduction.countCartons(total)}</strong>
          {total === null ? null : <span className="rp-count-dozens">{formatQuantityInDozens(total)}</span>}
        </div>
      </header>
      <div className="rp-body mpr-body">
        <ManualProductionForm machine={machine} products={products} busy={saving.busy} outcome={saving.outcome} onSave={saving.save} />
        <ManualProductionList day={day} />
      </div>
    </div>
  );
};
