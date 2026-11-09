import React, { useState } from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { FormField, ProductFields, useProductPick } from "../manualProduction/ProductFields";
import { useProductChoices } from "../manualProduction/useManualProduction";
import type { CartonAdjustDraft } from "../../types/desktopApi";
import type { AdjustOutcome } from "./useCartonStock";
import { CartonCloudOffNotice } from "../sync/CartonCloudOffNotice";

// ADJUST CARTON STOCK. One movement, with a reason, that every computer applies and shows. The main
// process checks everything again: that the person is an administrator, the quantity and the reason.

const text = copy.cartonStock;
const WHOLE_NUMBER = /^[1-9][0-9]{0,6}$/;

const Outcome: React.FC<{ outcome: AdjustOutcome }> = ({ outcome }) =>
  outcome.kind === "saved" ? (
    <p className="mpr-outcome is-saved" role="status"><strong>{text.savedTitle}</strong> {outcome.message}</p>
  ) : (
    <p className="mpr-outcome is-refused" role="alert"><strong>{text.refusedTitle}</strong> {outcome.message}</p>
  );

export const CartonAdjustForm: React.FC<{
  busy: boolean;
  outcome: AdjustOutcome | null;
  onAdjust: (draft: CartonAdjustDraft) => Promise<boolean>;
}> = ({ busy, outcome, onAdjust }) => {
  const products = useProductChoices();
  const pick = useProductPick(products.value);
  const [direction, setDirection] = useState<CartonAdjustDraft["direction"]>("IN");
  const [cartons, setCartons] = useState("");
  const [reason, setReason] = useState("");

  if (products.loading && products.value.length === 0) return <StateView kind="loading" compact message={text.productsLoading} />;
  if (products.error) return <StateView kind="error" compact message={products.error} onRetry={() => void products.reload()} />;
  if (products.value.length === 0) return <StateView kind="empty" compact title={text.noProductsTitle} hint={text.noProductsHint} />;

  const badCartons = cartons.trim() !== "" && !WHOLE_NUMBER.test(cartons.trim());
  const canSave = Boolean(pick.product && pick.color && WHOLE_NUMBER.test(cartons.trim()) && reason.trim()) && !busy;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    const saved = await onAdjust({ articleSizeId: pick.articleSizeId, color: pick.color, direction, cartons: Number(cartons.trim()), reason: reason.trim() });
    if (saved) {
      setCartons("");
      setReason("");
    }
  };

  return (
    <form className="card mpr-form" onSubmit={(event) => void submit(event)} aria-labelledby="carton-adjust-title">
      <CartonCloudOffNotice />
      <div className="mpr-form-head">
        <h3 id="carton-adjust-title" className="card-title">{text.formTitle}</h3>
      </div>
      <div className="mpr-grid">
        <ProductFields products={products.value} pick={pick} />
        <FormField label={text.directionLabel}>
          <select className="form-input" aria-label={text.directionLabel} value={direction}
            onChange={(event) => setDirection(event.target.value === "OUT" ? "OUT" : "IN")}>
            <option value="IN">{text.directionIn}</option>
            <option value="OUT">{text.directionOut}</option>
          </select>
        </FormField>
        <div className="mpr-field">
          <label className="input-label" htmlFor="carton-adjust-cartons">{text.cartonsLabel}</label>
          <input id="carton-adjust-cartons" className="form-input" inputMode="numeric" autoComplete="off" value={cartons}
            aria-invalid={badCartons} aria-describedby="carton-adjust-cartons-hint" onChange={(event) => setCartons(event.target.value)} />
          <span id="carton-adjust-cartons-hint" className={badCartons ? "mpr-hint is-error" : "mpr-hint"}>{badCartons ? `⚠ ${text.cartonsInvalid}` : text.cartonsHint}</span>
        </div>
        <div className="mpr-field">
          <label className="input-label" htmlFor="carton-adjust-reason">{text.reasonLabel}</label>
          <input id="carton-adjust-reason" className="form-input" autoComplete="off" value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
      </div>
      <p className="mpr-note">ⓘ {text.note}</p>
      <div className="mpr-actions">
        <button type="submit" className="btn btn-primary mpr-save" disabled={!canSave}>{busy ? text.saving : text.save}</button>
      </div>
      {outcome ? <Outcome outcome={outcome} /> : null}
    </form>
  );
};
