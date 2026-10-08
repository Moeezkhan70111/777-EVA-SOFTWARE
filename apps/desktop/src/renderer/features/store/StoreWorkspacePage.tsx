import React, { useState } from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import { StateView } from "../../components/shared/StateView";
import { useRawMaterialLookups } from "../rawMaterial/useRawMaterialLookups";
import { StockTab } from "../rawMaterial/StockTab";
import { LabelsTab } from "../rawMaterial/LabelsTab";
import { ReceiptsTab } from "../rawMaterial/ReceiptsTab";
import { SetupTab } from "../rawMaterial/SetupTab";
import type { WorkspaceTab } from "../rawMaterial/rawMaterial";
import { StoreTopBar } from "./StoreTopBar";

// One section of the Raw Material workspace — Stock, Labels, Receipts or Setup — shown
// full-screen inside the Move In flow. These are the workspace's own tab components with the
// same data and the same checks, so the store and the office use one implementation of each.

const TAB_TITLE: Record<WorkspaceTab, string> = {
  stock: copy.store.stockTitle,
  labels: copy.store.qrTitle,
  receipts: copy.store.receiptsTitle,
  setup: copy.store.setupTitle,
};

interface StoreWorkspacePageProps {
  tab: WorkspaceTab;
  username?: string;
  isAdmin: boolean;
  /** Whether this operator may print labels — the Stock tab offers a shortcut into them. */
  canPrintLabels: boolean;
  /** Back to the screen this section was opened from — the Move In operator's cards by default. */
  onDone: () => void;
  /** What the way back is called, and what the small line under the title says. The Munshi's
   *  station opens the same Stock section from its own screen, so both are adjustable. */
  backLabel?: string;
  stationLabel?: string;
  onNavigate: (route: AppRoute) => void;
}

export const StoreWorkspacePage: React.FC<StoreWorkspacePageProps> = (props) => {
  const lookups = useRawMaterialLookups();
  // The Stock tab's "Generate labels" switches this page to Labels for that material, the way
  // the workspace's own tab strip does, instead of leaving the store flow.
  const [tab, setTab] = useState<WorkspaceTab>(props.tab);
  const [labelsItemId, setLabelsItemId] = useState<string | undefined>(undefined);

  const openLabelsFor = (itemId: string) => {
    setLabelsItemId(itemId);
    setTab("labels");
  };

  return (
    <div className="so-page so-page--wide so-screen so-screen--in">
      <StoreTopBar
        title={TAB_TITLE[tab]}
        subtitle={props.stationLabel ?? `${copy.store.moveInTitle} ${copy.store.operator}`}
        back={{ label: props.backLabel ?? copy.store.moveInTitle, onClick: props.onDone }}
      />

      <main className="so-wide-body">
        {lookups.error && tab !== "receipts" && tab !== "labels" ? (
          <StateView kind="error" message={lookups.error} onRetry={() => void lookups.reload()} />
        ) : (
          <WorkspaceSection
            {...props}
            tab={tab}
            lookups={lookups}
            labelsItemId={labelsItemId}
            onLabelsItemConsumed={() => setLabelsItemId(undefined)}
            onGenerateLabels={openLabelsFor}
          />
        )}
      </main>
    </div>
  );
};

interface WorkspaceSectionProps extends StoreWorkspacePageProps {
  lookups: ReturnType<typeof useRawMaterialLookups>;
  labelsItemId?: string;
  onLabelsItemConsumed: () => void;
  onGenerateLabels: (itemId: string) => void;
}

/** The chosen tab, wired exactly as RawMaterialWorkspace wires it. */
const WorkspaceSection: React.FC<WorkspaceSectionProps> = ({
  tab,
  lookups,
  username,
  isAdmin,
  canPrintLabels,
  onNavigate,
  labelsItemId,
  onLabelsItemConsumed,
  onGenerateLabels,
}) => {
  if (tab === "stock") {
    return (
      <StockTab
        categories={lookups.categories}
        units={lookups.units}
        configByItem={lookups.configByItem}
        sections={lookups.sections}
        lookupsLoading={lookups.loading}
        onLookupsChanged={lookups.reload}
        onGenerateLabels={canPrintLabels ? onGenerateLabels : () => onNavigate("store-in-qr-generator")}
        isAdmin={isAdmin}
        onInitialItemConsumed={() => {}}
      />
    );
  }
  if (tab === "labels") {
    if (lookups.loading) return <StateView kind="loading" message={copy.common.loading} />;
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
