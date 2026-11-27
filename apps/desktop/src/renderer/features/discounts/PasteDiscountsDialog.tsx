import React, { useId, useMemo, useState } from "react";
import { Modal } from "../../components/shared/Modal";
import { copy } from "../../config/copy";
import { formatMoney } from "../../app/format";
import { readDiscountList, type ListedParty, type MatchedDiscount } from "./discountsFromList";

// PASTE DISCOUNTS (owner, 26 Nov 2026): "party | discount per pair" for the product group, article series or article
// chosen on Discount Policy. The list is read and shown first; "Fill in" puts the matches in the page's own table,
// where they are checked and saved by the page's Save, exactly as if typed. Nothing is saved from here.

const words = copy.discountsFromList;

interface PasteDiscountsDialogProps {
  /** What the discounts are for: "Product group SLIPPERS". */
  target: string;
  parties: readonly ListedParty[];
  onClose: () => void;
  onFill: (matched: MatchedDiscount[]) => void;
}

export const PasteDiscountsDialog: React.FC<PasteDiscountsDialogProps> = ({ target, parties, onClose, onFill }) => {
  const [text, setText] = useState("");
  const id = useId();
  const reading = useMemo(() => readDiscountList(text, parties), [text, parties]);
  const count = reading.matched.length;
  const footer = (
    <button type="button" className="btn btn-primary" disabled={count === 0} onClick={() => onFill(reading.matched)}>
      {words.fill(count)}
    </button>
  );

  return (
    <Modal themed title={words.title(target)} subtitle={words.subtitle} onClose={onClose} footer={footer} wide>
      <div className="form-group">
        <label htmlFor={`${id}-paste`}>{words.pasteLabel}</label>
        <textarea id={`${id}-paste`} className="form-input" rows={6} value={text} onChange={(event) => setText(event.target.value)} aria-describedby={`${id}-hint`} />
        <p id={`${id}-hint`} className="field-help">{words.pasteHint}</p>
      </div>
      {reading.unmatched.length > 0 ? <p className="error-message" role="alert">{words.unmatched(reading.unmatched.join(", "))}</p> : null}
      {reading.invalid.length > 0 ? <p className="error-message" role="alert">{words.invalid(reading.invalid.join(" · "))}</p> : null}
      {reading.repeated.length > 0 ? <p className="field-help">{words.repeated(reading.repeated.join(", "))}</p> : null}
      <h3 className="parties-list-preview-title">{count > 0 ? words.previewTitle(count) : words.previewEmpty}</h3>
      {count > 0 ? (
        <div className="table-wrap parties-list-preview">
          <table className="data-table" aria-label={words.previewTitle(count)}>
            <thead><tr><th scope="col">{words.customer}</th><th scope="col" className="doc-num">{words.discount}</th></tr></thead>
            <tbody>
              {reading.matched.map((row) => (
                <tr key={row.partyId}><td>{row.partyName}</td><td className="doc-num">{formatMoney(row.discountPerPair)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Modal>
  );
};
