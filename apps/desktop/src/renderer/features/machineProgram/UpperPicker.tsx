import React from "react";
import type { MachineProgramMaterial } from "../../types/desktopApi";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { formatAmount, upperKind } from "./machineProgram";
import { useUppers } from "./useMachineProgramData";

// AVAILABLE UPPER — SK6 7/10. Every upper the store holds for that article and size, whatever
// its colour: choose SK6 7/10 and the BLACK, GREEN and BROWN SK6 7/10 uppers all appear, because
// which colour of upper goes on the sole is the operator's choice.
//
// One card per upper, saying the colour, the article and size it is for, and how much of it is
// free. Where that stock came from is not asked and not shown — a program promises an upper, not
// a particular supplier's pile of it. A card that cannot be chosen says why in words (none left,
// already on this sole) rather than just going grey.
//
// The figures come from the data layer and already take every other program into account.

interface UpperPickerProps {
  machineId: string;
  articleSizeId: string;
  article: string;
  size: string;
  /** Uppers already on this sole — a second ADD would be the same line. */
  takenItemIds: ReadonlySet<string>;
  /** From useProgramWrites: changes on every save, so the cards' figures are read again. */
  stockVersion: number;
  onChoose: (material: MachineProgramMaterial) => void;
}

const refusal = (material: MachineProgramMaterial, taken: boolean): string | null => {
  if (taken) return copy.machineProgram.alreadyOnSole;
  if (!material.allocatable) return material.notAllocatableReason ?? copy.machineProgram.notForThisMachine;
  if (material.available <= 0) return copy.machineProgram.noneLeft;
  return null;
};

export const UpperPicker: React.FC<UpperPickerProps> = ({ machineId, articleSizeId, article, size, takenItemIds, stockVersion, onChoose }) => {
  const uppers = useUppers(machineId, articleSizeId, stockVersion);

  return (
    <section className="mp-panel" aria-label={`${copy.machineProgram.availableUpper} ${article} ${size}`}>
      <h3 className="mp-panel-title">
        {copy.machineProgram.availableUpper} <span className="mp-panel-title-sub">{article} · {size}</span>
      </h3>

      {uppers.loading && uppers.value.length === 0 ? (
        <StateView kind="loading" compact />
      ) : uppers.error ? (
        <StateView kind="error" compact message={uppers.error} onRetry={() => void uppers.reload()} />
      ) : uppers.value.length === 0 ? (
        <StateView kind="empty" compact title={copy.machineProgram.upperNoneTitle(article, size)} hint={copy.machineProgram.upperNoneHint} />
      ) : (
        <div className="mp-upper-cards">
          {uppers.value.map((material) => {
            const why = refusal(material, takenItemIds.has(material.itemId));
            return (
              <button key={material.itemId} type="button" className="mp-upper-card" disabled={why !== null} onClick={() => onChoose(material)}>
                <span className="mp-upper-name">
                  <ColorSwatch color={material.colour} className="mp-upper-swatch" />
                  {material.colour}
                </span>
                <span className="mp-upper-kind">
                  {article} {size} · {upperKind(material)}
                </span>
                {why ? (
                  <span className="mp-upper-why">{why}</span>
                ) : (
                  <span className="mp-upper-figure">
                    <span className="mp-upper-figure-label">{copy.machineProgram.available}</span>
                    {formatAmount(material.available, material.unitCode)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
};
