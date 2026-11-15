import React, { useEffect, useState } from "react";
import { STORE_DIRECTION, STORE_HAND_VOUCHER_NOTE_MAX, handVoucherNeedsNote, type StoreDirection } from "@erp/domain";
import { SearchableCombobox } from "../../../components/shared/SearchableCombobox";
import { copy } from "../../../config/copy";
import { PartyTypeBadge } from "../../parties/PartyTypeBadge";
import { PersonIcon } from "../StoreIcons";
import type { HandVoucherBodyInput } from "../../../types/desktopApi";
import { formatDate } from "../../../utils/dates";
import type { VoucherChoices } from "./useVoucherChoices";
import { VoucherLineRow } from "./VoucherLineRow";
import { availableFor, blankLine, bodyOf, draftReady, duplicateItems, isBlankLine, lineProblem, startingUnit, type DraftLine, type LineContext, type VoucherDraft } from "./voucherDraft";

// The voucher being written or edited:
//
//   Supplier [ SHEHZAD RUBBER ▾ ]                      Date  15 Nov 2026        (Move Out: "Moving out to")
//   1  [ NAWAAR 5 SOOTAR ▾ ]  [ 3 ]  [ RULE ▾ ]  = 2,925 INCH   ✕             (Move Out: "In store 1,950 INCH")
//   2  [ Choose a raw material ▾ ]                                 (always one empty line for the next material)
//   Reference [ Bilty 42 ]                                     [ Cancel ] [ Save voucher ]   (Move Out: What for *)

interface VoucherFormProps {
  initial: VoucherDraft;
  /** Which way the material moves, and — editing a Move Out voucher — what it already took out. */
  context: LineContext;
  /** The day the voucher is for: today for a new one, its own day when editing. */
  dateIso: string;
  choices: VoucherChoices;
  editing: boolean;
  busy: boolean;
  /** Resolves with the reason it was refused, or null once saved. */
  onSave: (body: HandVoucherBodyInput) => Promise<string | null>;
  onCancel?: () => void;
}

/** There is always one empty line at the end, for the next material. */
const withTrailingBlank = (lines: DraftLine[]): DraftLine[] => {
  const last = lines[lines.length - 1];
  return last && isBlankLine(last) ? lines : [...lines, blankLine()];
};

export const VoucherForm: React.FC<VoucherFormProps> = ({ initial, context, dateIso, choices, editing, busy, onSave, onCancel }) => {
  const words = copy.handVoucher;
  const side = words[context.direction];
  const [draft, setDraft] = useState<VoucherDraft>(initial);
  const [refusal, setRefusal] = useState<string | null>(null);
  const twice = duplicateItems(draft.lines);
  const ready = draftReady(draft, choices.optionsFor, context) && !busy;

  // An edited voucher starts with its lines: read each one's units once, so its figures can be checked.
  const { loadUnits } = choices;
  useEffect(() => {
    for (const line of initial.lines) if (line.itemId) void loadUnits(line.itemId);
    // Only the lines the form opened with; a chosen material reads its own units.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const update = (next: Partial<VoucherDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setRefusal(null);
  };

  const changeLine = (key: string, patch: Partial<DraftLine>) =>
    update({ lines: withTrailingBlank(draft.lines.map((line) => (line.key === key ? { ...line, ...patch } : line))) });

  const chooseItem = async (key: string, itemId: string) => {
    changeLine(key, { itemId, unitCode: "" });
    const options = await choices.loadUnits(itemId);
    if (options) {
      setDraft((current) => ({ ...current, lines: current.lines.map((line) => (line.key === key && line.itemId === itemId ? { ...line, unitCode: startingUnit(options) } : line)) }));
    }
  };

  const removeLine = (key: string) => update({ lines: withTrailingBlank(draft.lines.filter((line) => line.key !== key)) });

  const submit = async () => {
    if (!ready) return;
    setRefusal(await onSave(bodyOf(draft)));
  };

  /** Moving out, what the store can give for a line's material. */
  const availableOf = (itemId: string): number | null => {
    const options = choices.optionsFor(itemId);
    return context.direction === STORE_DIRECTION.OUT && options ? availableFor(options, context) : null;
  };

  return (
    <form
      className="siv-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="siv-head-fields">
        <div className="siv-field siv-field--supplier">
          <span className="mo-field-label">{side.party}</span>
          <SearchableCombobox
            value={draft.partyId}
            icon={<PersonIcon />}
            searchPlaceholder={copy.store.searchParty}
            options={choices.partyOptions}
            placeholder={choices.partyOptions.length === 0 ? side.noParties : side.choosePartyPlaceholder}
            emptyLabel={side.noPartyMatch}
            ariaLabel={side.party}
            onChange={(partyId) => update({ partyId })}
          />
          <PartyTypeBadge partyType={choices.parties.find((party) => party.id === draft.partyId)?.partyType} />
        </div>
        <div className="siv-field siv-field--date">
          <span className="mo-field-label">{words.date}</span>
          <span className="siv-date">{formatDate(dateIso)}</span>
        </div>
      </div>

      <p className="mo-field-label">{words.linesTitle}</p>
      <ol className="siv-lines" aria-label={words.linesTitle}>
        {draft.lines.map((line, index) => (
          <VoucherLineRow
            key={line.key}
            line={line}
            lineNo={index + 1}
            itemOptions={choices.itemOptions}
            options={choices.optionsFor(line.itemId)}
            problem={lineProblem(line, choices.optionsFor(line.itemId), twice.has(line.itemId), context)}
            available={availableOf(line.itemId)}
            removable={!isBlankLine(line)}
            disabled={busy}
            onChooseItem={(itemId) => void chooseItem(line.key, itemId)}
            onChange={(patch) => changeLine(line.key, patch)}
            onRemove={() => removeLine(line.key)}
          />
        ))}
      </ol>
      <p className="field-help">{words.blankLineHint}</p>

      <NoteField direction={context.direction} value={draft.note} onChange={(note) => update({ note })} />

      {refusal ? (
        <p className="mp-problem" role="alert">
          ⚠ {refusal}
        </p>
      ) : null}

      <div className="mo-commit siv-commit">
        {onCancel ? (
          <button type="button" className="btn btn-secondary btn-lg" disabled={busy} onClick={onCancel}>
            {words.cancel}
          </button>
        ) : null}
        <button type="submit" className="btn btn-primary btn-lg" disabled={!ready}>
          {busy ? words.saving : editing ? words.saveEdit : words.save}
        </button>
      </div>
    </form>
  );
};

/** Moving in, an optional reference. Moving out, what it is for, required. */
const NoteField: React.FC<{ direction: StoreDirection; value: string; onChange: (note: string) => void }> = ({ direction, value, onChange }) => {
  const side = copy.handVoucher[direction];
  const required = handVoucherNeedsNote(direction);
  return (
    <label className="siv-field">
      <span className="mo-field-label">
        {side.note}
        {required ? <span className="required-mark"> *</span> : <> <span className="text-muted">{copy.handVoucher.optional}</span></>}
      </span>
      <input
        className="form-input"
        value={value}
        maxLength={STORE_HAND_VOUCHER_NOTE_MAX}
        autoComplete="off"
        required={required}
        aria-required={required || undefined}
        placeholder={side.notePlaceholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {required && value.trim() === "" ? <span className="field-help">{side.noteMissing}</span> : null}
    </label>
  );
};
