import React from "react";
import { copy } from "../../config/copy";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { danaLabel } from "./machineProgram";
import { useSoleColours } from "./useMachineProgramData";

// Panel ① for a FIX article: both soles and the quantity, in the Sole Color card itself.
//
//   ① Sole Color                         EVR9 / 7/10
//   Outer sole colour  [ BLACK       ▾ ]
//   Inner sole colour  [ RED         ▾ ]
//   BLACK outer · RED inner
//   How many?  [ 30 ] DOZEN
//
// A fix article has no upper — it is moulded from an outer sole and an inner one — so the dialog
// shows no Upper Stock panel at all for it, and everything the run needs is asked here. There is
// no ceiling on the quantity and no stock figure beside it: a fix run reserves nothing, so there
// is nothing the store could run out of for it. Dana for both soles is issued on the Machine
// Program Issue screen, exactly as it is for any other sole.

interface FixSolePanelProps {
  outerColour: string | null;
  /** Omitted when the outer sole is the card's own colour: it is then shown, not chosen. */
  onChooseOuter?: (colour: string) => void;
  innerColour: string | null;
  onChooseInner: (colour: string) => void;
  quantity: string;
  onQuantityChange: (value: string) => void;
  /** Why what has been chosen cannot be saved, or null. */
  problem: string | null;
  disabled?: boolean;
  /** Shown in place of the outer dropdown when the colour is fixed by the card. */
  fixedOuter?: React.ReactNode;
}

export const FixSolePanel: React.FC<FixSolePanelProps> = (props) => {
  const { outerColour, onChooseOuter, innerColour, onChooseInner, quantity, onQuantityChange, problem, disabled = false, fixedOuter } = props;
  const colours = useSoleColours();
  if (colours.loading && colours.value.length === 0) return <StateView kind="loading" compact />;
  if (colours.error) return <StateView kind="error" compact message={colours.error} onRetry={() => void colours.reload()} />;

  // The same colours, with the Dana the store holds for each, as the sole colour list shows.
  const options = colours.value.map((option) => ({ value: option.colour, label: option.colour, detail: danaLabel(option) }));

  return (
    <div className="mpa-fix">
      <p className="mp-note">{copy.machineProgram.fixNoUpperNote}</p>

      <p className="mpa-field-label">{copy.machineProgram.outerSoleColour}</p>
      {onChooseOuter ? (
        <SearchableCombobox
          dropdown
          value={outerColour ?? ""}
          options={options}
          placeholder={copy.machineProgram.chooseOuterSole}
          ariaLabel={copy.machineProgram.outerSoleColour}
          emptyLabel={copy.machineProgram.soleColourNoMatch}
          onChange={onChooseOuter}
        />
      ) : (
        fixedOuter
      )}

      <p className="mpa-field-label">{copy.machineProgram.innerSoleColour}</p>
      <SearchableCombobox
        dropdown
        value={innerColour ?? ""}
        options={options}
        placeholder={copy.machineProgram.chooseInnerSole}
        ariaLabel={copy.machineProgram.innerSoleColour}
        emptyLabel={copy.machineProgram.soleColourNoMatch}
        onChange={onChooseInner}
      />

      {/* Said in words, because the sheet and the floor name both soles. */}
      {outerColour && innerColour && outerColour !== innerColour ? (
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
