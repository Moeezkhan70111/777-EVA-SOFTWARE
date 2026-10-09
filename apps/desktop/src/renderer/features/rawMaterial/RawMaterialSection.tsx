import React from "react";
import type { AppRoute } from "../../app/routes";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { StockTab } from "./StockTab";
import { LabelsTab } from "./LabelsTab";
import { ReceiptsTab } from "./ReceiptsTab";
import { SetupTab } from "./SetupTab";
import type { WorkspaceTab } from "./rawMaterial";
import type { useRawMaterialLookups } from "./useRawMaterialLookups";

// One section of the Raw Material workspace — Stock, Labels, Receipts or Setup — wired to the
// lookups it needs.
//
// Three screens show these sections: the office's Raw Material workspace, the Munshi's Stock
// station, and the Store In desk. They differ in what surrounds them (tab strip, way back, the
// scan pane beside them), never in what a section IS, so the wiring lives here once (R1) rather
// than being copied into each.

export type RawMaterialLookups = ReturnType<typeof useRawMaterialLookups>;

export interface RawMaterialSectionProps {
  tab: WorkspaceTab;
  lookups: RawMaterialLookups;
  /** The logged-in operator; recorded against label generation. */
  username?: string;
  isAdmin: boolean;
  /** What a material's "Generate labels" does — usually switch to the Labels section for it. */
  onGenerateLabels: (itemId: string) => void;
  /** A material the Labels section should open on. */
  labelsItemId?: string;
  onLabelsItemConsumed: () => void;
  /** A material the Stock section should open on — set when a notification about it was clicked. */
  initialItemId?: string;
  onInitialItemConsumed?: () => void;
  onNavigate: (route: AppRoute) => void;
}

export const RawMaterialSection: React.FC<RawMaterialSectionProps> = ({
  tab,
  lookups,
  username,
  isAdmin,
  onGenerateLabels,
  labelsItemId,
  onLabelsItemConsumed,
  initialItemId,
  onInitialItemConsumed,
  onNavigate,
}) => {
  // Receipts and Labels read their own data, so a lookup failure must not blank them.
  if (lookups.error && tab !== "receipts" && tab !== "labels") {
    return <StateView kind="error" message={lookups.error} onRetry={() => void lookups.reload()} />;
  }

  if (tab === "stock") {
    return (
      <StockTab
        categories={lookups.categories}
        units={lookups.units}
        configByItem={lookups.configByItem}
        sections={lookups.sections}
        lookupsLoading={lookups.loading}
        onLookupsChanged={lookups.reload}
        onGenerateLabels={onGenerateLabels}
        isAdmin={isAdmin}
        initialItemId={initialItemId}
        onInitialItemConsumed={onInitialItemConsumed ?? (() => {})}
      />
    );
  }

  if (tab === "labels") {
    if (lookups.loading && lookups.categories.length === 0) return <StateView kind="loading" message={copy.common.loading} />;
    return (
      <LabelsTab
        username={username}
        configByItem={lookups.configByItem}
        preselectItemId={labelsItemId}
        onPreselectConsumed={onLabelsItemConsumed}
        units={lookups.units}
        onLookupsChanged={lookups.reload}
      />
    );
  }

  if (tab === "receipts") return <ReceiptsTab username={username} onNavigate={onNavigate} />;

  return (
    <SetupTab
      isAdmin={isAdmin}
      categories={lookups.categories}
      units={lookups.units}
      sections={lookups.sections}
      loading={lookups.loading}
      error={lookups.error}
      onChanged={lookups.reload}
    />
  );
};
