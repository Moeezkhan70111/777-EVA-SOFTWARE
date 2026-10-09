import React, { useState } from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import { RawMaterialSection } from "../rawMaterial/RawMaterialSection";
import { useRawMaterialLookups } from "../rawMaterial/useRawMaterialLookups";
import type { WorkspaceTab } from "../rawMaterial/rawMaterial";
import { StoreTopBar } from "./StoreTopBar";

// One section of the Raw Material workspace shown full-screen with a way back — the Munshi's
// Stock station. The section itself is RawMaterialSection, the same component the Store In page
// and the office workspace render, so all three show one implementation of each tab.

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
  /** Back to the screen this section was opened from. */
  onDone: () => void;
  /** What the way back is called, and what the small line under the title says. */
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
        <RawMaterialSection
          tab={tab}
          lookups={lookups}
          username={props.username}
          isAdmin={props.isAdmin}
          onGenerateLabels={props.canPrintLabels ? openLabelsFor : () => props.onNavigate("store-in-qr-generator")}
          labelsItemId={labelsItemId}
          onLabelsItemConsumed={() => setLabelsItemId(undefined)}
          onNavigate={props.onNavigate}
        />
      </main>
    </div>
  );
};
