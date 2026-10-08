import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AppRoute } from "../../app/routes";
import { TabStrip, type TabStripItem } from "../../components/shared/TabStrip";
import { StateView } from "../../components/shared/StateView";
import { useRawMaterialLookups } from "./useRawMaterialLookups";
import { StockTab } from "./StockTab";
import { LabelsTab } from "./LabelsTab";
import { ReceiptsTab } from "./ReceiptsTab";
import { SetupTab } from "./SetupTab";
import type { WorkspaceTab } from "./rawMaterial";

// The Raw Material workspace: one destination for everything the office does with raw
// material, replacing six.
//
//   Stock     every material, what is in store, and whether it is ready to be scanned
//   Labels    registering and printing the QR labels that go on packets
//   Receipts  what was bought (bills) and what arrived (scanned deliveries)
//   Setup     categories, attributes, units, conversions and destinations
//
// The two scan stations stay separate full-screen pages: a scanner needs the whole screen and
// sole ownership of the keyboard, and putting one behind a tab strip would break it.
//
// Tabs are filtered by the permissions the user already holds, so this reproduces the old
// per-page access exactly rather than widening it — see features/auth/session.ts.

/** Any one of these opens the tab. */
const TAB_PERMISSION: Record<WorkspaceTab, string[]> = {
  stock: ["stock"],
  labels: ["raw-material-qr-generator"],
  receipts: ["stock"],
  setup: ["settings", "raw-material-setup"],
};

const TAB_LABELS: Record<WorkspaceTab, string> = {
  stock: "Stock",
  labels: "Labels",
  receipts: "Receipts",
  setup: "Setup",
};

interface RawMaterialWorkspaceProps {
  /** Which tab to open on. Deep-link routes preselect one. */
  initialTab?: WorkspaceTab;
  /** The logged-in operator; recorded against label generation. */
  username?: string;
  /** Permission codes the user holds. Admins pass `true` for allowAll. */
  permissions: string[];
  allowAll: boolean;
  /** A material to open on arrival — set when a notification about it was clicked. */
  initialItemId?: string;
  onInitialItemConsumed?: () => void;
  onNavigate: (route: AppRoute) => void;
}

export const RawMaterialWorkspace: React.FC<RawMaterialWorkspaceProps> = ({
  initialTab = "stock",
  username,
  permissions,
  allowAll,
  initialItemId,
  onInitialItemConsumed,
  onNavigate,
}) => {
  const lookups = useRawMaterialLookups();

  // Keyed on the permission VALUES, not the array identity: App hands down a fresh array on
  // every render, and an identity-keyed memo would make every dependent effect re-run.
  const permissionKey = permissions.join("|");
  const allowed = useMemo<WorkspaceTab[]>(
    () =>
      (["stock", "labels", "receipts", "setup"] as WorkspaceTab[]).filter(
        (tab) => allowAll || TAB_PERMISSION[tab].some((code) => permissionKey.split("|").includes(code))
      ),
    [permissionKey, allowAll]
  );

  const [tab, setTab] = useState<WorkspaceTab>(() =>
    allowed.includes(initialTab) ? initialTab : (allowed[0] ?? "stock")
  );
  const [labelsItemId, setLabelsItemId] = useState<string | undefined>(undefined);

  // A deep-link route (Settings ▸ Raw Material Setup, or the QR-generator permission route)
  // lands on its own tab. Applied once per change of the route's tab, never on a re-render:
  // App re-renders this workspace whenever the session refreshes, and re-applying would
  // throw the operator back to Stock mid-task.
  const appliedInitialTab = useRef<WorkspaceTab | null>(null);
  useEffect(() => {
    if (appliedInitialTab.current === initialTab) return;
    appliedInitialTab.current = initialTab;
    if (allowed.includes(initialTab)) setTab(initialTab);
  }, [initialTab, allowed]);

  const items: TabStripItem<WorkspaceTab>[] = allowed.map((id) => ({ id, label: TAB_LABELS[id] }));

  const openLabelsFor = (itemId: string) => {
    setLabelsItemId(itemId);
    setTab("labels");
  };

  return (
    <div className="page rm-workspace">
      <div className="rm-workspace-head">
        <div>
          <h1 className="page-title">Raw Material</h1>
          <p className="page-sub">
            Everything from defining a material to the labels that move it through the store.
          </p>
        </div>
        {items.length > 1 ? <TabStrip items={items} active={tab} onSelect={setTab} label="Raw material sections" /> : null}
      </div>

      {allowed.length === 0 ? (
        <StateView
          kind="empty"
          title="Nothing here for your account"
          hint="Ask an administrator for stock, label or settings access."
        />
      ) : lookups.error && tab !== "receipts" && tab !== "labels" ? (
        <StateView kind="error" message={lookups.error} onRetry={() => void lookups.reload()} />
      ) : (
        <>
          {tab === "stock" ? (
            <StockTab
              categories={lookups.categories}
              units={lookups.units}
              configByItem={lookups.configByItem}
              sections={lookups.sections}
              lookupsLoading={lookups.loading}
              onLookupsChanged={lookups.reload}
              onGenerateLabels={allowed.includes("labels") ? openLabelsFor : () => onNavigate("raw-material")}
              isAdmin={allowAll}
              initialItemId={initialItemId}
              onInitialItemConsumed={onInitialItemConsumed ?? (() => {})}
            />
          ) : null}

          {tab === "labels" ? (
            <LabelsTab
              username={username}
              configByItem={lookups.configByItem}
              preselectItemId={labelsItemId}
              onPreselectConsumed={() => setLabelsItemId(undefined)}
              units={lookups.units}
              onLookupsChanged={lookups.reload}
            />
          ) : null}

          {tab === "receipts" ? <ReceiptsTab username={username} onNavigate={onNavigate} /> : null}

          {tab === "setup" ? (
            <SetupTab
              isAdmin={allowAll}
              categories={lookups.categories}
              units={lookups.units}
              sections={lookups.sections}
              loading={lookups.loading}
              error={lookups.error}
              onChanged={lookups.reload}
            />
          ) : null}
        </>
      )}
    </div>
  );
};
