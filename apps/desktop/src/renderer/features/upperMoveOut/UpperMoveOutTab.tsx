import React, { useState } from "react";
import { TabStrip } from "../../components/shared/TabStrip";
import { copy } from "../../config/copy";
import { SCAN_STATION_CSS } from "../scanStation/scanStation";
import { MoveOutSection } from "./MoveOutSection";
import { UpperStockSection } from "./UpperStockSection";

// UPPER MOVE OUT — the QR Generator's fourth tab (Phase 3): issuing upper packets out of the store to
// a chosen machine, and the upper stock there is to issue.
//
//   Upper Move Out
//   Issue upper cartons to a selected machine.
//   [ Move Out ] [ Stock ]
//
// Move Out stays mounted while Stock is open, so the chosen machine is still chosen on the way back.
// Stock is read fresh each time it is opened, and kept current while it is.

type Section = "move-out" | "stock";

const text = copy.upperMoveOut;

export const UpperMoveOutTab: React.FC = () => {
  const [section, setSection] = useState<Section>("move-out");

  return (
    <div className="rp-tab um-tab">
      <style>{SCAN_STATION_CSS}</style>
      <header className="rp-head">
        <div>
          <h2 className="rp-title">{text.title}</h2>
          <p className="rp-subtitle">{text.subtitle}</p>
        </div>
      </header>
      <TabStrip
        items={[
          { id: "move-out", label: text.tabMoveOut },
          { id: "stock", label: text.tabStock },
        ]}
        active={section}
        onSelect={setSection}
        label={text.sectionsLabel}
      />
      <div role="tabpanel" aria-labelledby={`tab-${section}`}>
        <div hidden={section !== "move-out"}>
          <MoveOutSection />
        </div>
        {section === "stock" ? <UpperStockSection /> : null}
      </div>
    </div>
  );
};
