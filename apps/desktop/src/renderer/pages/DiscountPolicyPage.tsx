import React, { useState } from "react";
import { LEASE_DOMAIN } from "@erp/domain";
import { ReadOnlyNotice } from "../components/shared/ReadOnlyNotice";
import { StateView } from "../components/shared/StateView";
import { copy } from "../config/copy";
import { DiscountReport } from "../features/discounts/DiscountReport";
import { DISCOUNT_KIND, DISCOUNT_KINDS, type DiscountKind } from "../features/discounts/discountPolicy";
import { PriceRangeCard } from "../features/discounts/PriceRangeCard";
import { SetDiscountsCard } from "../features/discounts/SetDiscountsCard";
import { useDiscountPolicy } from "../features/discounts/useDiscountPolicy";
import { useWriteLease } from "../features/sync/useWriteLease";

// DISCOUNT POLICY (owner, 28 Nov 2026: "the discount page is not following our rules, style and guides and laws"), in
// the card pages' look (Customer Balance, Salaries; docs/56):
//
//   Discount Policy
//   ┌ Set discounts                         DISCOUNT ON [ Product group | Article series | Article | Price range ] ┐
//   │ Each box shows the customer's discount now…                                                             │
//   │ PRODUCT GROUP [ EVR GENTS ▾ ]   [ Search customers / ]   Customer | Discount / pair      [Save 2 changes] │
//   └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
//   ┌ Discount report    120 customers                                                         [Excel] [PDF]  ┐
//   │ SHOW [ All | Product group | … ]     Party name | EVR GENTS | EVR KIDS | EVR LADIES                        │
//   └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
//
// The rules travel with each customer (27 Nov 2026): written where PARTIES is held (PC1) and read everywhere; elsewhere
// the page says why (ReadOnlyNotice) and its boxes and Save are off. The four states: a skeleton while reading, an error
// with Retry, an empty prompt per card, and the tables (R12).

const text = copy.discountPolicy;

export const DiscountPolicyPage: React.FC = () => {
  const lease = useWriteLease(LEASE_DOMAIN.PARTIES);
  const policy = useDiscountPolicy();
  const [kind, setKind] = useState<DiscountKind>(DISCOUNT_KIND.PRODUCT_GROUP);
  const data = policy.data;

  const body = () => {
    if (policy.error && data === null) return <StateView kind="error" title={policy.error} onRetry={policy.reload} />;
    if (data === null) return <StateView kind="loading" message={text.loading} />;
    return (
      <>
        <section className="card dp-card" aria-labelledby="dp-set-title" aria-busy={policy.loading || undefined}>
          <header className="dp-card-head">
            <div>
              <h2 id="dp-set-title" className="dp-card-title">{text.setTitle}</h2>
              <p className="dp-muted">{text.setHint}</p>
            </div>
            <div className="dp-picker">
              <span className="input-label" id="dp-kind-label">{text.kindLabel}</span>
              <div className="sa-toggle" role="group" aria-labelledby="dp-kind-label">
                {DISCOUNT_KINDS.map((value) => (
                  <button key={value} type="button" className={kind === value ? "sa-toggle-btn is-on" : "sa-toggle-btn"} aria-pressed={kind === value} onClick={() => setKind(value)}>
                    {text.kinds[value]}
                  </button>
                ))}
              </div>
            </div>
          </header>
          {kind === DISCOUNT_KIND.PRICE_RANGE
            ? <PriceRangeCard data={data} canWrite={lease.canWrite} onSaved={policy.reload} />
            : <SetDiscountsCard key={kind} kind={kind} data={data} canWrite={lease.canWrite} onSaved={policy.reload} />}
        </section>
        {policy.error ? <StateView kind="error" compact message={policy.error} onRetry={policy.reload} /> : null}
        <DiscountReport report={data.report} />
      </>
    );
  };

  return (
    <div className="page doc-themed cl-page dp-page">
      <header className="cl-head">
        <div className="cl-head-title"><h1>{text.title}</h1></div>
      </header>
      <ReadOnlyNotice status={lease.status} />
      {body()}
    </div>
  );
};
