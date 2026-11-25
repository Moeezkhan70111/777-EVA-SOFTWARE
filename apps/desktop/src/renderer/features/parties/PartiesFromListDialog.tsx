import React, { useId } from "react";
import { PARTY_TYPES } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { copy } from "../../config/copy";
import { usePartiesFromList, type PartiesFromListOutcome } from "./usePartiesFromList";

// PASTE PARTIES (owner, 25 Nov 2026): a list of one city and group, read into a preview first, then added in one go.
// Every party is made as Add Party makes it (its own code, synced to the cloud from the computer that writes parties);
// a name already on file is skipped and said so.

const words = copy.partiesFromList;

interface PartiesFromListDialogProps {
  onClose: () => void;
  onAdded: (outcome: PartiesFromListOutcome) => void;
}

export const PartiesFromListDialog: React.FC<PartiesFromListDialogProps> = ({ onClose, onAdded }) => {
  const list = usePartiesFromList(onAdded);
  const id = useId();
  const count = list.rows.length;
  const footer = (
    <button type="button" className="btn btn-primary" disabled={count === 0 || list.saving} onClick={() => void list.save()}>
      {list.saving ? words.saving : words.save(count)}
    </button>
  );

  return (
    <Modal title={words.title} subtitle={words.subtitle} onClose={onClose} footer={footer} wide>
      <div className="form-group">
        <label htmlFor={`${id}-paste`}>{words.pasteLabel}</label>
        <textarea id={`${id}-paste`} className="form-input" rows={6} value={list.text} onChange={(event) => list.setText(event.target.value)} aria-describedby={`${id}-paste-hint`} />
        <p id={`${id}-paste-hint`} className="field-help">{words.pasteHint}</p>
      </div>
      <div className="parties-list-fields">
        <div className="form-group">
          <label htmlFor={`${id}-city`}>{words.cityLabel} <span className="required-mark">*</span></label>
          <input id={`${id}-city`} className="form-input" list={`${id}-cities`} value={list.city} onChange={(event) => list.setCity(event.target.value)} />
          <datalist id={`${id}-cities`}>{list.cities.map((city) => <option key={city} value={city} />)}</datalist>
        </div>
        <div className="form-group">
          <label htmlFor={`${id}-group`}>{words.groupLabel}</label>
          <input id={`${id}-group`} className="form-input" list={`${id}-groups`} value={list.groupName} onChange={(event) => list.setGroupName(event.target.value)} aria-describedby={`${id}-group-hint`} />
          <datalist id={`${id}-groups`}>{list.groups.map((group) => <option key={group} value={group} />)}</datalist>
          <p id={`${id}-group-hint`} className="field-help">{words.groupHint}</p>
        </div>
        <div className="form-group">
          <label htmlFor={`${id}-type`}>{words.typeLabel}</label>
          <select id={`${id}-type`} className="form-input" value={list.partyType} onChange={(event) => list.setPartyType(event.target.value)}>
            {PARTY_TYPES.map((type) => <option key={type} value={type}>{copy.parties.typeLabel[type] ?? type}</option>)}
          </select>
        </div>
      </div>
      {list.error ? <p className="error-message" role="alert">{list.error}</p> : null}
      <h3 className="parties-list-preview-title">{count > 0 ? words.previewTitle(count) : words.previewEmpty}</h3>
      {count > 0 ? (
        <div className="table-wrap parties-list-preview">
          <table className="data-table" aria-label={words.previewTitle(count)}>
            <thead><tr><th scope="col">{words.english}</th><th scope="col">{words.urdu}</th></tr></thead>
            <tbody>
              {list.rows.map((row, index) => (
                <tr key={`${index}-${row.partyName}`}><td>{row.partyName}</td><td lang="ur" dir="rtl" className="urdu-text">{row.partyNameUrdu}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Modal>
  );
};
