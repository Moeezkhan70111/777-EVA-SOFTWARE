import React from "react";
import { copy } from "../../../config/copy";
import type { ReconciliationLine, ReconciliationParty } from "../../../types/desktopApi";
import { ClaimRows } from "./ClaimRows";
import { UpperBalance } from "./UpperBalance";
import { UpperBCarton } from "./UpperBCarton";
import { UpperLineFigures } from "./UpperLineFigures";
import { cleanCount, type UpperDraft } from "./upperDraft";
import type { ConvertUpperToB } from "./useUpperActions";

// One short upper on the reconciliation — every way its missing pairs can go, on one card:
//
//   SK6 7/10 · BLACK / RED
//   Expected 12 · Upper returned 4 · Cartons back 6 · B cartons 1 · Remaining 1 (6 pairs)
//   ┌ B-Carton MIX ┐ ┌ Cut Size Upper ┐ ┌ Cut Size Pairs ┐        Balance
//   ┌ Damaged / Claim ───────────────────────────────┐        Unresolved 0 ✓
//
// Nothing is a step of anything else: every way is open at once, and typing in one never clears
// another. B cartons are made at once (they print labels); the rest is saved when the program closes.

const text = copy.programClose;

const PairsBox: React.FC<{ id: string; title: string; hint: string; label: string; value: string; disabled: boolean; onChange: (value: string) => void }> = ({ id, title, hint, label, value, disabled, onChange }) => (
  <div className="mur-action">
    <label className="mur-action-label" htmlFor={id}>
      <span className="mur-action-title">{title}</span>
      <span className="mur-action-hint">{hint}</span>
    </label>
    <div className="mur-action-row">
      <input id={id} className="form-input mur-count" type="text" inputMode="numeric" placeholder="0" value={value} aria-label={label} disabled={disabled} onChange={(event) => onChange(cleanCount(event.target.value))} />
      <span className="mur-unit">{text.pairsUnit}</span>
    </div>
  </div>
);

interface UpperLineCardProps {
  line: ReconciliationLine;
  draft: UpperDraft;
  parties: { machine: ReconciliationParty | null; packing: ReconciliationParty | null };
  convertToB: ConvertUpperToB;
  disabled: boolean;
  onChange: (draft: UpperDraft) => void;
}

export const UpperLineCard: React.FC<UpperLineCardProps> = ({ line, draft, parties, convertToB, disabled, onChange }) => {
  const name = text.lineName(line.article, line.size, line.soleColour, line.upperColour);
  const set = (patch: Partial<UpperDraft>) => onChange({ ...draft, ...patch });
  return (
    <section className="mur-line" aria-label={name}>
      <h4 className="mur-line-title">{name}</h4>
      <UpperLineFigures line={line} name={name} />
      <div className="mur-line-body">
        <div className="mur-actions">
          <UpperBCarton line={line} name={name} convert={convertToB} disabled={disabled} />
          <PairsBox
            id={`cut-upper-${line.lineId}`}
            title={text.cutUpperTitle}
            hint={text.cutUpperHint}
            label={text.pairsOf(text.cutUpperTitle, name)}
            value={draft.cutSizeUppers}
            disabled={disabled}
            onChange={(cutSizeUppers) => set({ cutSizeUppers })}
          />
          <PairsBox
            id={`cut-pairs-${line.lineId}`}
            title={text.cutPairsTitle}
            hint={text.cutPairsHint}
            label={text.pairsOf(text.cutPairsTitle, name)}
            value={draft.cutSizePairs}
            disabled={disabled}
            onChange={(cutSizePairs) => set({ cutSizePairs })}
          />
          <ClaimRows line={line} claims={draft.claims} parties={parties} disabled={disabled} onChange={(claims) => set({ claims })} />
        </div>
        <UpperBalance line={line} name={name} draft={draft} />
      </div>
    </section>
  );
};
