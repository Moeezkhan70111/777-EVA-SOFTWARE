import React, { useState } from "react";
import { STORE_DIRECTION } from "@erp/domain";
import type { AppRoute } from "../../../app/routes";
import { copy } from "../../../config/copy";
import { StateView } from "../../../components/shared/StateView";
import { TabStrip } from "../../../components/shared/TabStrip";
import { RawMaterialSection } from "../../rawMaterial/RawMaterialSection";
import type { useRawMaterialLookups } from "../../rawMaterial/useRawMaterialLookups";
import { StoreDailyReport } from "../dailyReport/StoreDailyReport";
import { ManualEntry } from "../sections/ManualEntry";
import { NewMaterialForm } from "../sections/NewMaterialForm";
import { RECEIVING_TABS, allowedTabs, shownTab, type ReceivingTab, type StoreAccess } from "./storeTabs";

// RECEIVING's work area: Add material | Labels | Stock | Receipts | By hand | Setup — the sections
// Store In had, under their 0.3.9 names, each with the permission it always needed. The Daily report
// (a header button) takes the pane in their place until a tab is chosen.

interface ReceivingWorkAreaProps {
  token: string;
  username?: string;
  isAdmin: boolean;
  access: StoreAccess;
  lookups: ReturnType<typeof useRawMaterialLookups>;
  /** The Daily report is open in place of the tabs. */
  reportOpen: boolean;
  onCloseReport: () => void;
  onNavigate: (route: AppRoute) => void;
}

export const ReceivingWorkArea: React.FC<ReceivingWorkAreaProps> = (props) => {
  const { token, username, isAdmin, access, lookups, reportOpen, onCloseReport, onNavigate } = props;
  const [chosen, setChosen] = useState<ReceivingTab>("material");
  // A fresh, empty form after each material is created — the desk stays open for the next one.
  const [formKey, setFormKey] = useState(0);
  const [labelsItemId, setLabelsItemId] = useState<string | undefined>(undefined);
  const allowed = allowedTabs(RECEIVING_TABS, access);
  const tab = shownTab(chosen, allowed);

  const select = (next: ReceivingTab) => {
    setChosen(next);
    onCloseReport();
  };
  const openLabelsFor = (itemId: string) => {
    setLabelsItemId(itemId);
    select("labels");
  };

  const pane = (() => {
    if (reportOpen) return <StoreDailyReport direction={STORE_DIRECTION.IN} token={token} />;
    if (!tab) return <StateView kind="empty" title={copy.storePage.noTabs} hint={copy.storePage.noTabsHint} />;
    if (tab === "material") return <NewMaterialForm lookups={lookups} formKey={formKey} onDone={() => setFormKey((key) => key + 1)} />;
    if (tab === "byHand") return <ManualEntry token={token} />;
    return (
      <RawMaterialSection
        tab={tab}
        lookups={lookups}
        username={username}
        isAdmin={isAdmin}
        onGenerateLabels={access.labels ? openLabelsFor : () => select("labels")}
        labelsItemId={labelsItemId}
        onLabelsItemConsumed={() => setLabelsItemId(undefined)}
        onNavigate={onNavigate}
      />
    );
  })();

  return (
    <div className="sp-work sp-work--receiving">
      {allowed.length > 0 ? (
        <TabStrip
          items={allowed.map((entry) => ({ id: entry.id, label: entry.label }))}
          active={reportOpen ? null : tab}
          onSelect={select}
          label={copy.storePage.receivingSections}
        />
      ) : null}
      <section className="sp-work-pane" aria-label={reportOpen ? copy.storePage.reportFor(copy.storePage.receiving) : copy.storePage.receivingSections}>
        {pane}
      </section>
    </div>
  );
};
