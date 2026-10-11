import React from "react";
import { copy } from "../../../config/copy";
import type { ReconciliationLine, ReconciliationParty } from "../../../types/desktopApi";
import { accountedUppers, cleanCount, draftProblem, type LineDraft } from "./reconciliationDraft";

// One short upper on the reconciliation screen.
//
//   SK6 7/10 · BLACK GREY           7 of 8 cartons back · 6 uppers to account for
//   Cut size [ 4 ]   Wastage [ 1 ]   Lost [ 1 ]
//   Claim to supplier  (ABC UPPER)          Why were they wasted?  [ torn upper            ]
//   Claim to  (Machine — ALAMGIR) (Packing — DANIYAL)   How were they lost?  [ …          ]
//   6 of 6 accounted for
//
// The claim's party and reason are only asked for once there is something to claim, and the line
// says in words what is still missing — never by colour alone.

interface ReconciliationLineFormProps {
  line: ReconciliationLine;
  draft: LineDraft;
  machineContractor: ReconciliationParty | null;
  packingContractor: ReconciliationParty | null;
  disabled: boolean;
  onChange: (draft: LineDraft) => void;
}

/** A row of pressed / not-pressed buttons: one choice, said in words. */
const Choice: React.FC<{
  label: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  value: string | null;
  disabled: boolean;
  onChoose: (value: string) => void;
}> = ({ label, options, value, disabled, onChoose }) => (
  <div className="mpr-choice" role="group" aria-label={label}>
    <span className="mpr-field-label">{label}</span>
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        className={`mpr-choice-btn${value === option.value ? " is-chosen" : ""}`}
        aria-pressed={value === option.value}
        disabled={disabled || option.disabled}
        onClick={() => onChoose(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
);

const CountBox: React.FC<{ label: string; hint: string; value: string; upper: string; disabled: boolean; onChange: (value: string) => void }> = ({
  label,
  hint,
  value,
  upper,
  disabled,
  onChange,
}) => (
  <label className="mpr-way">
    <span className="mpr-way-label">{label}</span>
    <input
      className="form-input mpr-way-input"
      type="text"
      inputMode="numeric"
      placeholder="0"
      value={value}
      disabled={disabled}
      aria-label={copy.programClose.uppersFor(label, upper)}
      onChange={(event) => onChange(cleanCount(event.target.value))}
    />
    <span className="mpr-way-hint">{hint}</span>
  </label>
);

const ReasonBox: React.FC<{ label: string; value: string; disabled: boolean; onChange: (value: string) => void }> = ({ label, value, disabled, onChange }) => (
  <label className="mpr-reason">
    <span className="mpr-field-label">{label}</span>
    <input
      className="form-input"
      type="text"
      value={value}
      placeholder={copy.programClose.reasonPlaceholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  </label>
);

export const ReconciliationLineForm: React.FC<ReconciliationLineFormProps> = (props) => {
  const { line, draft, machineContractor, packingContractor, disabled, onChange } = props;
  const upper = `${line.article} ${line.size} ${line.upperColour}`;
  const set = (patch: Partial<LineDraft>) => onChange({ ...draft, ...patch });
  const problem = draftProblem(line, draft);

  return (
    <section className="mpr-line" aria-label={upper}>
      <header className="mpr-line-head">
        <h3 className="mpr-line-title">{copy.programClose.lineHead(upper, line.cartonsBack, line.cartonsDue ?? 0)}</h3>
        <span className="mpr-line-short">{copy.programClose.lineShort(line.shortfallUppers)}</span>
      </header>

      <div className="mpr-ways">
        <CountBox label={copy.programClose.cutSize} hint={copy.programClose.cutSizeHint} value={draft.cutSize} upper={upper} disabled={disabled} onChange={(cutSize) => set({ cutSize })} />
        <CountBox label={copy.programClose.wastage} hint={copy.programClose.wastageHint} value={draft.wastage} upper={upper} disabled={disabled} onChange={(wastage) => set({ wastage })} />
        <CountBox label={copy.programClose.lost} hint={copy.programClose.lostHint} value={draft.lost} upper={upper} disabled={disabled} onChange={(lost) => set({ lost })} />
      </div>

      {Number(draft.wastage) > 0 ? (
        <div className="mpr-claim">
          <Choice
            label={copy.programClose.supplier}
            options={line.suppliers.map((supplier) => ({ value: supplier.partyId, label: supplier.name }))}
            value={draft.wastagePartyId}
            disabled={disabled}
            onChoose={(wastagePartyId) => set({ wastagePartyId })}
          />
          <ReasonBox label={copy.programClose.wastageReason} value={draft.wastageReason} disabled={disabled} onChange={(wastageReason) => set({ wastageReason })} />
        </div>
      ) : null}

      {Number(draft.lost) > 0 ? (
        <div className="mpr-claim">
          <Choice
            label={copy.programClose.claimTo}
            options={[
              { value: "MACHINE", label: copy.programClose.machineContractor(machineContractor?.name ?? "—"), disabled: !machineContractor },
              {
                value: "PACKING",
                label: packingContractor ? copy.programClose.packingContractor(packingContractor.name) : copy.programClose.noPackingContractor,
                disabled: !packingContractor,
              },
            ]}
            value={draft.lostParty}
            disabled={disabled}
            onChoose={(lostParty) => set({ lostParty: lostParty === "PACKING" ? "PACKING" : "MACHINE" })}
          />
          <ReasonBox label={copy.programClose.lostReason} value={draft.lostReason} disabled={disabled} onChange={(lostReason) => set({ lostReason })} />
        </div>
      ) : null}

      <p className={`mpr-line-status${problem ? "" : " is-ok"}`} role="status">
        {problem ? `⚠ ${problem}` : `✓ ${copy.programClose.accounted(accountedUppers(draft), line.shortfallUppers)}`}
      </p>
    </section>
  );
};
