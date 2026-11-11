import React from "react";
import { CARTON_ADJUSTMENT_KIND, type CartonAdjustmentDirection, type CartonAdjustmentKind } from "@erp/domain";
import { copy } from "../../config/copy";
import { resultOf, typedCartons } from "./stockAdjustmentDraft";
import type { AdjustmentChoice } from "./stockAdjustmentReply";

// One article and colour, a row per size: in store now, the quantity typed, the figure it would leave. A size that
// already has opening stock says so in words and takes no opening quantity. Enter adds the typed sizes.

const text = copy.stockAdjustment;

interface SizeQuantityTableProps {
  kind: CartonAdjustmentKind;
  direction: CartonAdjustmentDirection;
  rows: readonly AdjustmentChoice[];
  typed: Readonly<Record<string, string>>;
  problems: ReadonlyArray<string | null>;
  onType: (articleSizeId: string, value: string) => void;
  onEnter: () => void;
}

const resultText = (row: AdjustmentChoice, direction: CartonAdjustmentDirection, typed: string): string => {
  const cartons = typedCartons(typed);
  if (cartons === null || !Number.isFinite(cartons)) return "—";
  return String(resultOf({ inStore: row.inStore, direction, cartons }));
};

export const SizeQuantityTable: React.FC<SizeQuantityTableProps> = ({ kind, direction, rows, typed, problems, onType, onEnter }) => {
  const opening = kind === CARTON_ADJUSTMENT_KIND.OPENING;
  return (
    <div className="sa-table-wrap">
      <table className="data-table sa-table">
        <thead>
          <tr>
            <th scope="col">{text.sizeColumn}</th>
            <th scope="col" className="sa-num">{text.inStoreColumn}</th>
            <th scope="col" className="sa-num">{opening ? text.openingColumn : text.directions[direction]}</th>
            <th scope="col" className="sa-num">{text.resultColumn}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const locked = opening && row.hasOpening;
            const problem = problems[index] ?? null;
            const inputId = `sa-qty-${row.articleSizeId}`;
            return (
              <tr key={row.articleSizeId} className={problem ? "is-invalid" : undefined}>
                <th scope="row">{row.size}</th>
                <td className="sa-num">{row.inStore}</td>
                <td className="sa-num">
                  {locked ? (
                    <span className="sa-note">{text.hasOpening}</span>
                  ) : (
                    <>
                      <input id={inputId} className="form-input sa-qty" inputMode="numeric" autoComplete="off" value={typed[row.articleSizeId] ?? ""}
                        aria-label={text.quantityFor(row.size)} aria-invalid={problem !== null} aria-describedby={problem ? `${inputId}-problem` : undefined}
                        onChange={(event) => onType(row.articleSizeId, event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onEnter(); } }} />
                      {problem ? <span id={`${inputId}-problem`} className="sa-problem" role="alert">⚠ {problem}</span> : null}
                    </>
                  )}
                </td>
                <td className="sa-num sa-result">{locked ? row.inStore : resultText(row, direction, typed[row.articleSizeId] ?? "")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
