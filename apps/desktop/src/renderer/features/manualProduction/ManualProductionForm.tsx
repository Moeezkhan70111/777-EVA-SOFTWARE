import React, { useState } from "react";
import { manualProductionCartons, type ManualProductionQuantity } from "@erp/domain";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { Loaded } from "../../hooks/useLoaded";
import type { MachineRecord } from "../../types/desktopApi";
import { articlesOf, sizesOf, type ProductChoice } from "./productChoices";
import type { ManualProductionDraft, SaveOutcome } from "./useManualProduction";

// RECORD PRODUCTION — the Manual Production form:
//
//   Record production                       On MACHINE 1's program for today.
//   Article [ SK6 ▾ ]   Size [ 7/10 ▾ ]   Colour [ RED ▾ ]
//   Quantity (dozens) [ 10 ]   = 20 cartons into store stock
//   ⓘ These cartons have no QR label, so they cannot be dispatched by scanning.
//   [ Save production ]
//   ✓ Saved — MAN-000001: 20 cartons of SK6 7/10 RED added to stock.
//
// The machine is the workspace's picker above. The cartons shown are the domain's own rule
// (manualProductionCartons) — the same one the main process applies before writing any stock.
// After a Save the product stays chosen and the quantity is cleared, so the next entry is a new one.

const text = copy.manualProduction;

interface ManualProductionFormProps {
  machine: MachineRecord | null;
  products: Loaded<ProductChoice[]>;
  busy: boolean;
  outcome: SaveOutcome | null;
  onSave: (draft: ManualProductionDraft) => Promise<boolean>;
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="mpr-field">
    <span className="input-label" aria-hidden="true">{label}</span>
    {children}
  </div>
);

/** Under the quantity: how to type it, the cartons it makes, or why it is not a quantity. */
const quantityHint = (typed: boolean, quantity: ManualProductionQuantity): string => {
  if (!typed) return text.dozensHint;
  return quantity.ok ? text.cartonsPreview(quantity.cartons) : `⚠ ${quantity.reason}`;
};

const Outcome: React.FC<{ outcome: SaveOutcome }> = ({ outcome }) =>
  outcome.kind === "saved" ? (
    <p className="mpr-outcome is-saved" role="status"><strong>{text.savedTitle}</strong> {outcome.message}</p>
  ) : (
    <p className="mpr-outcome is-refused" role="alert"><strong>{text.refusedTitle}</strong> {outcome.message}</p>
  );

export const ManualProductionForm: React.FC<ManualProductionFormProps> = ({ machine, products, busy, outcome, onSave }) => {
  const [article, setArticle] = useState("");
  const [articleSizeId, setArticleSizeId] = useState("");
  const [color, setColor] = useState("");
  const [dozens, setDozens] = useState("");

  if (products.loading && products.value.length === 0) return <StateView kind="loading" compact message={text.productsLoading} />;
  if (products.error) return <StateView kind="error" compact message={products.error} onRetry={() => void products.reload()} />;
  if (products.value.length === 0) return <StateView kind="empty" compact title={text.noProductsTitle} hint={text.noProductsHint} />;

  const sizes = sizesOf(products.value, article);
  const product = sizes.find((choice) => choice.articleSizeId === articleSizeId) ?? null;
  const quantity = manualProductionCartons(dozens);
  const badQuantity = dozens.trim() !== "" && !quantity.ok;
  const canSave = Boolean(machine && product && color && quantity.ok) && !busy;

  const chooseArticle = (value: string) => {
    setArticle(value);
    setArticleSizeId("");
    setColor("");
  };
  const chooseSize = (value: string) => {
    setArticleSizeId(value);
    setColor("");
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSave || !machine) return;
    if (await onSave({ machineId: machine.id, articleSizeId, color, dozens: dozens.trim() })) setDozens("");
  };

  return (
    <form className="card mpr-form" onSubmit={(event) => void submit(event)} aria-labelledby="mpr-form-title">
      <div className="mpr-form-head">
        <h3 id="mpr-form-title" className="card-title">{text.formTitle}</h3>
        <span className={machine ? "mpr-machine" : "mpr-machine is-missing"}>{machine ? text.machineLine(machine.name) : text.machineNeeded}</span>
      </div>
      <div className="mpr-grid">
        <Field label={text.articleLabel}>
          <SearchableCombobox dropdown ariaLabel={text.articleLabel} placeholder={text.chooseArticle} value={article}
            options={articlesOf(products.value).map((name) => ({ value: name, label: name }))} onChange={chooseArticle} />
        </Field>
        <Field label={text.sizeLabel}>
          <SearchableCombobox dropdown ariaLabel={text.sizeLabel} placeholder={text.chooseSize} value={articleSizeId}
            options={sizes.map((choice) => ({ value: choice.articleSizeId, label: choice.size }))} onChange={chooseSize} />
        </Field>
        <Field label={text.colorLabel}>
          <SearchableCombobox dropdown ariaLabel={text.colorLabel} placeholder={text.chooseColor} value={color}
            emptyLabel={text.noColors} options={(product?.colors ?? []).map((name) => ({ value: name, label: name }))} onChange={setColor} />
        </Field>
        <div className="mpr-field">
          <label className="input-label" htmlFor="mpr-dozens">{text.dozensLabel}</label>
          <input id="mpr-dozens" className="form-input mpr-dozens" inputMode="decimal" autoComplete="off" value={dozens}
            aria-describedby="mpr-dozens-hint" aria-invalid={badQuantity} onChange={(event) => setDozens(event.target.value)} />
          <span id="mpr-dozens-hint" className={badQuantity ? "mpr-hint is-error" : "mpr-hint"}>{quantityHint(dozens.trim() !== "", quantity)}</span>
        </div>
      </div>
      <p className="mpr-note">ⓘ {text.noQrNote}</p>
      <div className="mpr-actions">
        <button type="submit" className="btn btn-primary mpr-save" disabled={!canSave}>{busy ? text.saving : text.save}</button>
      </div>
      {outcome ? <Outcome outcome={outcome} /> : null}
    </form>
  );
};
