import React from "react";
import { copy } from "../../config/copy";
import { StateView } from "../../components/shared/StateView";
import { ColourStep } from "./RunSteps";

// Panel ③ for a FIX article: no upper, a second sole instead.
//
//   ③ Inner Sole & Quantity              EVR9 / 7/10
//   ● BLACK  ● RED  ● WHITE
//   BLACK outer · RED inner
//   How many?  [ 30 ] DOZEN
//
// It takes the place of the Upper Stock panel, because a fix article has no upper to fetch — it
// is moulded from an outer sole and an inner one. There is no ceiling on the quantity and no
// stock figure beside it: a fix run reserves nothing, so there is nothing the store could run
// out of for it. Dana for both soles is issued on the Machine Program Issue screen, exactly as
// it is for any other sole.

interface FixSolePanelProps {
  /** The outer sole, chosen in panel ①, so the pair can be said in full. */
  outerColour: string | null;
  innerColour: string | null;
  onChooseInner: (colour: string) => void;
  quantity: string;
  onQuantityChange: (value: string) => void;
  /** Why the typed quantity cannot be saved, or null. */
  problem: string | null;
  /** False until an article and size are chosen — there is nothing to count yet. */
  ready: boolean;
  disabled?: boolean;
}

export const FixSolePanel: React.FC<FixSolePanelProps> = ({
  outerColour,
  innerColour,
  onChooseInner,
  quantity,
  onQuantityChange,
  problem,
  ready,
  disabled = false,
}) => {
  if (!ready) return <StateView kind="empty" compact title={copy.machineProgram.chooseArticleFirst} />;

  return (
    <div className="mpa-fix">
      <p className="mp-note">{copy.machineProgram.fixNoUpperNote}</p>

      <p className="mpa-field-label">{copy.machineProgram.innerSoleColour}</p>
      <ColourStep layout="rows" selected={innerColour} onChoose={onChooseInner} />

      {/* Said in words, because the sheet and the floor name both soles. */}
      {outerColour && innerColour ? (
        <p className="mpa-fix-pair">{copy.machineProgram.fixPair(outerColour, innerColour)}</p>
      ) : null}

      <label className="mpa-field-label" htmlFor="mpa-fix-quantity">
        {copy.machineProgram.howMany}
      </label>
      <div className="mp-quantity-row">
        <input
          id="mpa-fix-quantity"
          className="form-input mp-quantity-input"
          type="text"
          inputMode="decimal"
          value={quantity}
          disabled={disabled}
          autoComplete="off"
          aria-invalid={problem ? true : undefined}
          onChange={(event) => onQuantityChange(event.target.value)}
        />
        <span className="mp-quantity-unit">{copy.machineProgram.dozenUnit}</span>
      </div>
      <p className="mp-note">{copy.machineProgram.quantityHelp}</p>
      {problem ? (
        <p className="mp-problem" role="alert">
          ⚠ {problem}
        </p>
      ) : null}
    </div>
  );
};
