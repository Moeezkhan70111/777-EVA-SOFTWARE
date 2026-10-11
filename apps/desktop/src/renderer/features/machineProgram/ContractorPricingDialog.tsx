import React, { useState } from "react";
import { fromPaisa, programContractorPricing, type ContractorRates } from "@erp/domain";
import type { MachineProgramRecord } from "../../types/desktopApi";
import { Modal } from "../../components/shared/Modal";
import { StateView } from "../../components/shared/StateView";
import { formatMoney } from "../../app/format";
import { copy } from "../../config/copy";
import {
  ContractorRateFields,
  rateDraftOf,
  rateDraftProblem,
  rateDraftToPaisa,
  rateDraftToRupees,
  sameRates,
  type RateDraft,
} from "./ContractorRateFields";
import { formatAmount } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// CONTRACTOR PRICING — every article on the program, and what its work is paid at.
//
//   SK6  / 7/10   100 DOZEN programmed    machine [45.00]  packing [18.00]  printing [12.00]
//   SK12 / 1/6     50 DOZEN programmed    machine [52.00]  packing [20.00]  printing [ 0.00]
//
// The other half of the pricing entered while an article is added: this is where it is CHANGED,
// for an article already on the program, without having to add an upper to get at the boxes.
//
// One article is one row, however many sole runs or injectors it is spread across — the same
// rule the table is stored under (migration 063), so the figure here can never disagree with
// what a run elsewhere on the program is paid.
//
// Each article is its own saved transaction, as every other program write is. Only what was
// actually changed is sent, so re-opening the dialog and pressing Save writes nothing.

interface ContractorPricingDialogProps {
  program: MachineProgramRecord;
  writes: ProgramWrites;
  onClose: () => void;
}

export const ContractorPricingDialog: React.FC<ContractorPricingDialogProps> = ({ program, writes, onClose }) => {
  const pricing = programContractorPricing({ runs: program.runs, rates: program.articleRates });
  const [drafts, setDrafts] = useState<Record<string, RateDraft>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const draftFor = (articleSizeId: string, stored: ContractorRates | null): RateDraft =>
    drafts[articleSizeId] ?? rateDraftOf(stored);

  const changed = pricing.articles.filter((article) => {
    const draft = drafts[article.articleSizeId];
    // Untouched boxes are never sent, so re-opening this dialog and pressing Save writes nothing.
    if (!draft) return false;
    // An article nobody has priced is saved as soon as its boxes are touched — including when all
    // three are left at zero, which is how "this article's work is not paid" is recorded. Without
    // this it would be indistinguishable from unpriced and could never be set.
    if (!article.rates) return true;
    return !sameRates(rateDraftToPaisa(draft), article.rates);
  });
  const anyProblem = pricing.articles.some((article) => rateDraftProblem(draftFor(article.articleSizeId, article.rates)) !== null);
  const ready = changed.length > 0 && !anyProblem;

  /** One article, one transaction. The first refusal stops the rest; what saved stays saved. */
  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      for (const article of changed) {
        const answer = await writes.saveArticleRates({
          programId: program.id,
          articleSizeId: article.articleSizeId,
          ...rateDraftToRupees(draftFor(article.articleSizeId, article.rates)),
        });
        if (!answer.ok) {
          setProblem(copy.machineProgram.pricingSaveFailed(article.article, article.size, answer.reason));
          return;
        }
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={copy.machineProgram.pricingDialogTitle(program.code)}
      subtitle={copy.machineProgram.pricingDialogSubtitle}
      wide="xl"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary btn-lg" disabled={!ready || saving} onClick={() => void save()}>
          {saving ? copy.machineProgram.pricingSaving : copy.machineProgram.pricingSave}
        </button>
      }
    >
      <p className="mp-note">{copy.machineProgram.pricingNote}</p>

      {pricing.articles.length === 0 ? (
        <StateView kind="empty" compact title={copy.machineProgram.pricingEmpty} hint={copy.machineProgram.pricingEmptyHint} />
      ) : (
        <ul className="mpr-articles">
          {pricing.articles.map((article) => {
            const draft = draftFor(article.articleSizeId, article.rates);
            const why = rateDraftProblem(draft);
            return (
              <li className="mpr-article" key={article.articleSizeId}>
                <div className="mpr-article-head">
                  <span className="mpr-article-name">
                    {copy.machineProgram.pricingFor(article.article, article.size)}
                  </span>
                  <span className="mpr-article-qty">
                    {copy.machineProgram.pricingArticleQuantity(formatAmount(article.quantity, article.unitCode))}
                  </span>
                  {article.committed ? (
                    <span className="mpr-article-amount">
                      {copy.machineProgram.colCommitted}: {formatMoney(fromPaisa(article.committed.totalPaisa))}
                    </span>
                  ) : (
                    <span className="mpr-article-unpriced">{copy.machineProgram.pricingUnpricedRow}</span>
                  )}
                </div>
                <ContractorRateFields
                  idPrefix={`mpr-${article.articleSizeId}`}
                  value={draft}
                  onChange={(next) => {
                    setProblem(null);
                    setDrafts((previous) => ({ ...previous, [article.articleSizeId]: next }));
                  }}
                  disabled={saving}
                />
                {why ? (
                  <p className="mp-problem" role="alert">
                    ⚠ {why}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {!ready && !anyProblem && pricing.articles.length > 0 ? (
        <p className="mp-note">{copy.machineProgram.pricingNothingChanged}</p>
      ) : null}

      {problem ? (
        <p className="mp-problem" role="alert">
          ⚠ {problem}
        </p>
      ) : null}
    </Modal>
  );
};
