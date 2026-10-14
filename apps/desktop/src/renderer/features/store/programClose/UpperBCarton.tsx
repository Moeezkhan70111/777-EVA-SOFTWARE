import React, { useState } from "react";
import { upperBConversionProblem } from "@erp/domain";
import { copy } from "../../../config/copy";
import { ConfirmDialog } from "../../../components/shared/ConfirmDialog";
import type { ReconciliationLine } from "../../../types/desktopApi";
import { cleanCount } from "./upperDraft";
import type { ConvertUpperToB } from "./useUpperActions";

// B-CARTON MIX — missing cartons that came back in mixed colours.
//
//   B-Carton MIX   [ 1 ]  [ Generate B labels ]
//
// Generating prints that many MIX labels, grade B, and cancels every label of this upper that is
// not back (the owner's rule). It asks first, because labels once cancelled cannot be scanned.

const text = copy.programClose;

export const UpperBCarton: React.FC<{ line: ReconciliationLine; name: string; convert: ConvertUpperToB; disabled: boolean }> = ({ line, name, convert, disabled }) => {
  const [typed, setTyped] = useState("");
  const [asking, setAsking] = useState(false);
  const count = Number(typed);
  const problem = typed === "" ? null : upperBConversionProblem(count, line.missingCartons);

  return (
    <div className="mur-action">
      <label className="mur-action-label" htmlFor={`b-${line.lineId}`}>
        <span className="mur-action-title">{text.bUpperTitle}</span>
        <span className="mur-action-hint">{text.bUpperHint}</span>
      </label>
      <div className="mur-action-row">
        <input
          id={`b-${line.lineId}`}
          className="form-input mur-count"
          type="text"
          inputMode="numeric"
          placeholder="0"
          value={typed}
          aria-label={text.bUpperCount(name)}
          disabled={disabled || line.missingCartons === 0}
          onChange={(event) => setTyped(cleanCount(event.target.value))}
        />
        <button type="button" className="btn btn-secondary" disabled={disabled || typed === "" || Boolean(problem)} onClick={() => setAsking(true)}>
          {text.bGenerate}
        </button>
      </div>
      {problem ? <p className="mur-field-problem" role="alert">⚠ {problem}</p> : null}

      {asking ? (
        <ConfirmDialog
          title={text.bUpperConfirmTitle(count)}
          facts={[
            { label: text.bColArticle, value: name },
            { label: text.bUpperVoided, value: text.bUpperVoidedValue },
            { label: text.bConfirmNew, value: text.bConfirmNewValue(count, line.article, line.size) },
          ]}
          explain={text.bUpperExplain(count)}
          confirmLabel={text.bGenerate}
          tone="primary"
          busyLabel={text.bGenerating}
          onConfirm={async () => {
            const refusal = await convert(line, count);
            if (!refusal) setTyped("");
            return refusal;
          }}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  );
};
