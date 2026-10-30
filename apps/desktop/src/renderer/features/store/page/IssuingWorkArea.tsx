import React, { useState } from "react";
import { STORE_DIRECTION } from "@erp/domain";
import type { AppRoute } from "../../../app/routes";
import { copy } from "../../../config/copy";
import { TabStrip } from "../../../components/shared/TabStrip";
import { RawMaterialSection } from "../../rawMaterial/RawMaterialSection";
import type { useRawMaterialLookups } from "../../rawMaterial/useRawMaterialLookups";
import { StoreDailyReport } from "../dailyReport/StoreDailyReport";
import { HandMovePanel } from "../HandMovePanel";
import { IssuedToday } from "./IssuedToday";
import { ISSUING_TABS, allowedTabs, shownTab, type IssuingTab, type StoreAccess } from "./storeTabs";

// ISSUING's work area: By hand | Issued today | Stock | Daily report. By hand is Move Out by Hand,
// Stock the same section Receiving shows, and Daily report the day's issues (a tab since 0.4.1).

interface IssuingWorkAreaProps {
  token: string;
  username?: string;
  isAdmin: boolean;
  access: StoreAccess;
  lookups: ReturnType<typeof useRawMaterialLookups>;
  /** Changes whenever this computer's issue session moves, so Issued today follows it. */
  sessionKey: string;
  onNavigate: (route: AppRoute) => void;
}

export const IssuingWorkArea: React.FC<IssuingWorkAreaProps> = (props) => {
  const { token, username, isAdmin, access, lookups, sessionKey, onNavigate } = props;
  const [chosen, setChosen] = useState<IssuingTab>("byHand");
  const allowed = allowedTabs(ISSUING_TABS, access);
  const tab = shownTab(chosen, allowed) ?? "byHand";

  const pane = (() => {
    if (tab === "report") return <StoreDailyReport direction={STORE_DIRECTION.OUT} token={token} />;
    if (tab === "issuedToday") return <IssuedToday refreshKey={sessionKey} username={username} />;
    if (tab === "stock") {
      return (
        <RawMaterialSection
          tab="stock"
          lookups={lookups}
          username={username}
          isAdmin={isAdmin}
          onGenerateLabels={() => undefined}
          onLabelsItemConsumed={() => undefined}
          onNavigate={onNavigate}
        />
      );
    }
    return (
      <div className="si-manual-open">
        <header className="si-manual-head">
          <h2 className="si-manual-title">{copy.moveOut.manualTitle}</h2>
        </header>
        <HandMovePanel direction="OUT" token={token} />
      </div>
    );
  })();

  return (
    <div className="sp-work sp-work--issuing">
      <TabStrip
        items={allowed.map((entry) => ({ id: entry.id, label: entry.label }))}
        active={tab}
        onSelect={setChosen}
        label={copy.storePage.issuingSections}
      />
      <section className="sp-work-pane" aria-label={tab === "report" ? copy.storePage.reportFor(copy.storePage.issuing) : copy.storePage.issuingSections}>
        {pane}
      </section>
    </div>
  );
};
