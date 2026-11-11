import React from "react";
import { CARTON_ADJUSTMENT_KIND, type CartonAdjustmentKind } from "@erp/domain";
import { TabStrip } from "../../components/shared/TabStrip";
import { copy } from "../../config/copy";
import type { DraftHeader } from "./stockAdjustmentDraft";

// The document's header: which kind, its date, why, and any remarks. The number is given when it is posted.

const text = copy.stockAdjustment;

interface AdjustmentHeaderProps {
  header: DraftHeader;
  onKind: (kind: CartonAdjustmentKind) => void;
  onChange: (header: DraftHeader) => void;
}

export const AdjustmentHeader: React.FC<AdjustmentHeaderProps> = ({ header, onKind, onChange }) => (
  <section className="card sa-card" aria-labelledby="sa-header-title">
    <div className="sa-card-head">
      <h3 id="sa-header-title" className="card-title">{text.headerTitle}</h3>
      <span className="sa-number">{text.numberOnPost}</span>
    </div>
    <TabStrip
      label={text.kindLabel}
      active={header.kind}
      onSelect={onKind}
      items={[
        { id: CARTON_ADJUSTMENT_KIND.OPENING, label: text.kinds.OPENING },
        { id: CARTON_ADJUSTMENT_KIND.ADJUSTMENT, label: text.kinds.ADJUSTMENT },
      ]}
    />
    <p className="sa-hint">{text.kindHint[header.kind]}</p>
    <div className="sa-header-grid">
      <label className="mpr-field">
        <span className="input-label">{text.dateLabel}</span>
        <input type="date" className="form-input" value={header.businessDate} required
          onChange={(event) => onChange({ ...header, businessDate: event.target.value })} />
      </label>
      <label className="mpr-field sa-wide">
        <span className="input-label">{text.reasonLabel}</span>
        <input className="form-input" value={header.reason} required maxLength={200} placeholder={text.reasonPlaceholder[header.kind]}
          onChange={(event) => onChange({ ...header, reason: event.target.value })} />
      </label>
      <label className="mpr-field sa-wide">
        <span className="input-label">{text.remarksLabel}</span>
        <input className="form-input" value={header.remarks} maxLength={500} placeholder={text.remarksPlaceholder}
          onChange={(event) => onChange({ ...header, remarks: event.target.value })} />
      </label>
    </div>
  </section>
);
