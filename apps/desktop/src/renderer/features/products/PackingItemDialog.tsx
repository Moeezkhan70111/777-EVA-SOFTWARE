import React, { useState } from "react";
import { Modal } from "../../components/shared/Modal";
import { copy } from "../../config/copy";
import { draftFor, parsePackingItem, type PackingRateItem } from "./packingRateItems";

// The popup behind the packing rate's "+": one attribute, a name and a price.
//
//   Add Packing Attribute
//   Name of Attribute  [ BOX   ]
//   Price              [ 50    ]
//                       Cancel  Add
//
// The same popup edits an attribute already on the list, opened with its values.

interface PackingItemDialogProps {
  /** The attribute being edited, or null to add a new one. */
  item: PackingRateItem | null;
  onSave: (item: PackingRateItem) => void;
  onClose: () => void;
}

const FORM_ID = "packing-item-form";
const PRICE_PATTERN = /^\d*\.?\d*$/;

export const PackingItemDialog: React.FC<PackingItemDialogProps> = ({ item, onSave, onClose }) => {
  const [draft, setDraft] = useState(() => draftFor(item));
  const [error, setError] = useState<string | null>(null);
  const text = copy.products.packingItems;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = parsePackingItem(draft);
    if (result.error !== null) {
      setError(result.error);
      return;
    }
    onSave(result.item);
  };

  const change = (field: "name" | "price", value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setError(null);
  };

  return (
    <Modal
      title={item ? text.editTitle : text.addTitle}
      subtitle={text.dialogSubtitle}
      onClose={onClose}
      className="product-add-modal"
      footer={
        <button type="submit" form={FORM_ID} className="btn btn-primary">
          {item ? copy.common.save : text.addButton}
        </button>
      }
    >
      <form id={FORM_ID} onSubmit={submit} noValidate>
        <div className="form-group">
          <label htmlFor="packingItemName" className="input-label">
            {text.name} <span className="required-mark">*</span>
          </label>
          <input
            id="packingItemName"
            type="text"
            className="form-input input-upper"
            value={draft.name}
            onChange={(event) => change("name", event.target.value.toUpperCase())}
            placeholder={text.namePlaceholder}
            autoComplete="off"
            autoFocus
          />
        </div>
        <div className="form-group">
          <label htmlFor="packingItemPrice" className="input-label">
            {text.price} <span className="required-mark">*</span>
            <span className="label-hint">({copy.machineProgram.perDozen})</span>
          </label>
          <input
            id="packingItemPrice"
            type="text"
            inputMode="decimal"
            className="form-input"
            value={draft.price}
            onChange={(event) => {
              if (PRICE_PATTERN.test(event.target.value)) change("price", event.target.value);
            }}
            placeholder={text.pricePlaceholder}
            autoComplete="off"
          />
        </div>
        {error ? (
          <p className="error-message" role="alert">
            ⚠ {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
};
