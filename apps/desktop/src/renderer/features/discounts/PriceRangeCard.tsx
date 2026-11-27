import React, { useState } from "react";
import { fromPaisa, toPaisa, typedRupeesToPaisa } from "@erp/domain";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { DISCOUNT_KIND, discountText } from "./discountPolicy";
import type { DiscountPolicyData } from "./useDiscountPolicy";

// PRICE RANGES for one customer (docs/56): the ranges they have now, listed (recognition), then new ones to add, each
// From, To and the discount per pair, typed loosely and checked (Postel). A new range is removed with a 44px button
// beside it. Save names how many ranges it adds. The same call the page always made (createPartyPriceRangeDiscount).

const text = copy.discountPolicy;
interface NewRange { readonly from: string; readonly to: string; readonly discount: string }
const EMPTY: NewRange = { from: "", to: "", discount: "" };
const paisaOf = (typed: string) => typedRupeesToPaisa(typed.trim().replace(/,/g, ""));

/** A new range ready to save, or null while it is not one. */
const readyRange = (range: NewRange) => {
  const [from, to, discount] = [paisaOf(range.from), paisaOf(range.to), paisaOf(range.discount)];
  return from !== null && to !== null && discount !== null && to > from ? { startPrice: fromPaisa(from), endPrice: fromPaisa(to), discountPerPair: fromPaisa(discount) } : null;
};

interface PriceRangeCardProps {
  data: DiscountPolicyData;
  canWrite: boolean;
  onSaved: () => void;
}

export const PriceRangeCard: React.FC<PriceRangeCardProps> = ({ data, canWrite, onSaved }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [partyId, setPartyId] = useState("");
  const [ranges, setRanges] = useState<NewRange[]>([EMPTY]);
  const [saving, setSaving] = useState(false);
  const party = data.customers.find((customer) => customer.id === partyId);
  const now = data.report.filter((line) => line.partyId === partyId && line.type === DISCOUNT_KIND.PRICE_RANGE && line.discountPerPair > 0);
  const touched = ranges.filter((range) => range.from || range.to || range.discount);
  const ready = touched.map(readyRange);
  const incomplete = ready.some((range) => range === null);
  const set = (index: number, field: keyof NewRange, value: string) => setRanges((previous) => previous.map((range, at) => (at === index ? { ...range, [field]: value } : range)));

  const save = async () => {
    setSaving(true);
    let saved = 0;
    for (const range of ready) {
      if (!range) continue;
      const reply = await api.createPartyPriceRangeDiscount({ partyId, ...range }).catch((error: unknown) => ({ accepted: false, reason: leaseRefusalText(error) ?? text.couldNotSave }));
      if (reply.accepted) saved += 1;
      else push("error", text.notSavedTitle, text.notSaved(party?.partyName ?? "", reply.reason ?? text.couldNotSave));
    }
    setSaving(false);
    if (saved > 0) { push("success", text.savedTitle, text.savedBody(saved, text.kinds.PRICE_RANGE)); setRanges([EMPTY]); onSaved(); }
  };

  const options = data.customers.map((customer) => ({ value: customer.id, label: customer.partyName }));
  return (
    <>
      <div className="dp-pickers">
        <label className="dp-picker">
          <span className="input-label">{text.targets.PRICE_RANGE}</span>
          <SearchableCombobox ariaLabel={text.targets.PRICE_RANGE} placeholder={text.targetPlaceholders.PRICE_RANGE} searchPlaceholder={text.targetSearch} emptyLabel={text.noTargets}
            value={partyId} options={options} onChange={(value) => { setPartyId(value); setRanges([EMPTY]); }} />
        </label>
      </div>
      {!party ? <StateView kind="empty" compact title={text.chooseTitle.PRICE_RANGE} hint={text.chooseHint.PRICE_RANGE} /> : (
        <>
          <section className="dp-ranges-now" aria-label={text.rangesNow}>
            <span className="input-label">{text.rangesNow}</span>
            {now.length === 0 ? <p className="dp-muted">{text.rangesNone}</p> : (
              <ul className="dp-range-list">
                {now.map((line) => <li key={line.label}><span>{line.label}</span><strong>Rs {discountText(toPaisa(line.discountPerPair))}</strong></li>)}
              </ul>
            )}
          </section>
          <div className="dp-range-rows">
            {ranges.map((range, index) => (
              <div key={index} className="dp-range-row" role="group" aria-label={`${text.newRange} ${index + 1}`}>
                <label><span className="input-label">{text.rangeFrom}</span><input className="form-input dp-input" inputMode="decimal" value={range.from} disabled={!canWrite || saving} onChange={(event) => set(index, "from", event.target.value)} /></label>
                <label><span className="input-label">{text.rangeTo}</span><input className="form-input dp-input" inputMode="decimal" value={range.to} disabled={!canWrite || saving} onChange={(event) => set(index, "to", event.target.value)} /></label>
                <label><span className="input-label">{text.discountColumn}</span><input className="form-input dp-input" inputMode="decimal" value={range.discount} disabled={!canWrite || saving} onChange={(event) => set(index, "discount", event.target.value)} /></label>
                <button type="button" className="btn btn-secondary dp-remove" aria-label={text.removeRange(index + 1)} disabled={ranges.length === 1 || saving}
                  onClick={() => setRanges((previous) => previous.filter((_, at) => at !== index))}>×</button>
              </div>
            ))}
          </div>
          <div className="dp-actions">
            {incomplete ? <span className="dp-problem" role="status">⚠ {text.rangeIncomplete}</span> : <span />}
            <button type="button" className="btn btn-secondary" disabled={!canWrite || saving} onClick={() => setRanges((previous) => [...previous, EMPTY])}>{text.addRange}</button>
            <button type="button" className="btn btn-primary" disabled={!canWrite || saving || touched.length === 0 || incomplete} onClick={() => void save()}>
              {saving ? text.saving : text.saveRanges(touched.length)}
            </button>
          </div>
        </>
      )}
    </>
  );
};
