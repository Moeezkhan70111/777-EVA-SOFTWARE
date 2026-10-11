import React from "react";
import { fromPaisa, programContractorPricing } from "@erp/domain";
import type { MachineProgramRecord } from "../../types/desktopApi";
import { formatMoney } from "../../app/format";
import { copy } from "../../config/copy";
import { formatAmount } from "./machineProgram";

// CONTRACTOR PRICING on the program summary: the rates, and what the day is committed to at
// them.
//
//   CONTRACTOR PRICING                                     [ Edit Pricing ]
//   Article       Machine   Packing   Printing   For the program
//   SK6  7/10       45.00     18.00      12.00         7,500.00
//   SK12 1/6        52.00     20.00       0.00         3,600.00
//   Total at these rates                              11,100.00
//
// Read-only. Every figure comes from `programContractorPricing` in @erp/domain, which is the
// same function the printed sheet uses — the screen adds nothing up itself.
//
// "For the program" is deliberately not called "owed". A contractor earns on what is PRODUCED,
// and production is not yet recorded against a program, so this column is what the day commits
// to at the agreed rates and the note under the table says so.

interface ProgramPricingProps {
  program: MachineProgramRecord;
  /** Opens the pricing dialog. Absent while the program cannot be changed. */
  onEdit?: () => void;
}

export const ProgramPricing: React.FC<ProgramPricingProps> = ({ program, onEdit }) => {
  const pricing = programContractorPricing({ runs: program.runs, rates: program.articleRates });
  if (pricing.articles.length === 0) return null;

  const money = (paisa: number) => formatMoney(fromPaisa(paisa));

  return (
    <section className="mpx-pricing" aria-label={copy.machineProgram.pricingTitle}>
      <header className="mpx-pricing-head">
        <h3 className="mpx-summary-subtitle">{copy.machineProgram.pricingTitle}</h3>
        {onEdit ? (
          <button type="button" className="mpx-pricing-edit" onClick={onEdit}>
            {pricing.articles.some((article) => article.rates) ? copy.machineProgram.pricingEdit : copy.machineProgram.pricingSet}
          </button>
        ) : null}
      </header>

      <table className="mpx-pricing-table">
        <thead>
          <tr>
            <th scope="col">{copy.machineProgram.colArticleSize}</th>
            <th scope="col" className="mpx-num">
              {copy.machineProgram.colMachine}
            </th>
            <th scope="col" className="mpx-num">
              {copy.machineProgram.colPacking}
            </th>
            <th scope="col" className="mpx-num">
              {copy.machineProgram.colPrinting}
            </th>
            <th scope="col" className="mpx-num">
              {copy.machineProgram.colCommitted}
            </th>
          </tr>
        </thead>
        <tbody>
          {pricing.articles.map((article) => (
            <tr key={article.articleSizeId}>
              <th scope="row">
                <span className="mpx-pricing-article">{copy.machineProgram.pricingFor(article.article, article.size)}</span>
                <span className="mpx-pricing-qty">{formatAmount(article.quantity, article.unitCode)}</span>
              </th>
              {article.rates ? (
                <>
                  <td className="mpx-num">{money(article.rates.machineRatePaisa)}</td>
                  <td className="mpx-num">{money(article.rates.packingRatePaisa)}</td>
                  <td className="mpx-num">{money(article.rates.printingRatePaisa)}</td>
                  <td className="mpx-num">
                    <b>{money(article.committed?.totalPaisa ?? 0)}</b>
                  </td>
                </>
              ) : (
                // Said in words, never left as a dash the reader has to interpret: an article
                // with no rates is not an article priced at nothing.
                <td className="mpx-pricing-unpriced" colSpan={4}>
                  {copy.machineProgram.pricingUnpricedRow}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{copy.machineProgram.pricingTotal}</th>
            <td className="mpx-num">{money(pricing.committed.machinePaisa)}</td>
            <td className="mpx-num">{money(pricing.committed.packingPaisa)}</td>
            <td className="mpx-num">{money(pricing.committed.printingPaisa)}</td>
            <td className="mpx-num">
              <b>{money(pricing.committed.totalPaisa)}</b>
            </td>
          </tr>
        </tfoot>
      </table>

      <p className="mpx-pricing-note">{copy.machineProgram.pricingNote}</p>
      {pricing.unpricedArticles > 0 ? (
        <p className="mpx-pricing-warn" role="status">
          ⚠ {copy.machineProgram.pricingUnpriced(pricing.unpricedArticles)}
        </p>
      ) : null}
    </section>
  );
};
