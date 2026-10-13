import React from "react";
import { upperSizeForArticleSize } from "@erp/domain";
import type { MachineProgramMaterial } from "../../types/desktopApi";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { PlusIcon } from "./MachineProgramIcons";
import { formatAmount } from "./machineProgram";
import { useUppers } from "./useMachineProgramData";

// UPPER STOCK — SK6 / 7/10. Every upper the store holds for that article and size, whatever its
// colour: choose SK6 7/10 and the BLACK, GREEN and BROWN SK6 7/10 uppers all appear, because
// which colour of upper goes on the sole is the operator's choice.
//
// The size asked for is the UPPER's, which is not always the article's: one 1/6 upper is cut for
// both the 1/3 and the 4/6 soles (upperSizeForArticleSize), so SK30 4/6 lists SK30 1/6 uppers.
// Nothing here decides that — the rule is the domain's, and the data layer offers from it — but
// the empty state names the size the store would have to RECEIVE, not the article's own.
//
//   Upper Color      Available Stock     Action
//   ● Brown          10 DOZEN            [ + Add ]
//   ● Black          15 DOZEN            Already on this sole
//
// One row per upper, saying the colour, how much of it is free, and the one thing that can be
// done with it. Where that stock came from is not asked and not shown — a program promises an
// upper, not a particular supplier's pile of it. A row that cannot be added says why in words
// (none left, already on this sole, already chosen) rather than just going grey (R18).
//
// The figures come from the data layer and already take every other program into account.

interface UpperPickerProps {
  machineId: string;
  /** Null until the article and the size are both chosen — then the panel asks for them. */
  articleSizeId: string | null;
  article: string | null;
  size: string | null;
  /** Uppers already on this sole — a second ADD would be the same line. */
  takenItemIds: ReadonlySet<string>;
  /** Uppers already waiting in the selection below, not yet saved. */
  chosenItemIds: ReadonlySet<string>;
  /** From useProgramWrites: changes on every save, so the rows' figures are read again. */
  stockVersion: number;
  onAdd: (material: MachineProgramMaterial) => void;
}

const refusal = (material: MachineProgramMaterial, taken: boolean, chosen: boolean): string | null => {
  if (taken) return copy.machineProgram.alreadyOnSole;
  if (chosen) return copy.machineProgram.alreadyChosen;
  if (!material.allocatable) return material.notAllocatableReason ?? copy.machineProgram.notForThisMachine;
  if (material.available <= 0) return copy.machineProgram.noneLeft;
  return null;
};

export const UpperPicker: React.FC<UpperPickerProps> = ({
  machineId,
  articleSizeId,
  article,
  size,
  takenItemIds,
  chosenItemIds,
  stockVersion,
  onAdd,
}) => {
  const uppers = useUppers(machineId, articleSizeId, stockVersion);

  if (!articleSizeId || !article || !size) {
    return <StateView kind="empty" compact title={copy.machineProgram.chooseArticleSizeFirst} />;
  }
  if (uppers.loading && uppers.value.length === 0) return <StateView kind="loading" compact />;
  if (uppers.error) return <StateView kind="error" compact message={uppers.error} onRetry={() => void uppers.reload()} />;
  if (uppers.value.length === 0) {
    return (
      <StateView
        kind="empty"
        compact
        title={copy.machineProgram.upperNoneTitle(article, upperSizeForArticleSize(size))}
        hint={copy.machineProgram.upperNoneHint}
      />
    );
  }

  return (
    <div className="mpa-table-wrap">
      <table className="mpa-table">
        <thead>
          <tr>
            <th scope="col">{copy.machineProgram.colUpper}</th>
            <th scope="col" className="mpa-num">
              {copy.machineProgram.colAvailableStock}
            </th>
            <th scope="col">{copy.machineProgram.colAction}</th>
          </tr>
        </thead>
        <tbody>
          {uppers.value.map((material) => {
            const why = refusal(material, takenItemIds.has(material.itemId), chosenItemIds.has(material.itemId));
            return (
              <tr key={material.itemId}>
                <td>
                  <span className="mpa-colour">
                    <ColorSwatch color={material.colour} className="mpa-swatch" />
                    {material.colour}
                  </span>
                </td>
                <td className="mpa-num">{formatAmount(material.available, material.unitCode)}</td>
                <td>
                  {why ? (
                    <span className="mpa-why">{why}</span>
                  ) : (
                    <button
                      type="button"
                      className="mpa-add"
                      aria-label={copy.machineProgram.addUpperTo(material.colour)}
                      onClick={() => onAdd(material)}
                    >
                      <PlusIcon className="mpx-btn-icon" />
                      {copy.machineProgram.add}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
