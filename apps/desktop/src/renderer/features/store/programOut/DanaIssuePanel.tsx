import React, { useCallback, useEffect, useMemo, useState } from "react";
import { copy } from "../../../config/copy";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { useNotifications } from "../../../state/NotificationsContext";
import { StateView } from "../../../components/shared/StateView";
import { getColorHex } from "../../../components/shared/ColorSwatch";
import type { MachineProgramDanaOption } from "../../../types/desktopApi";
import { formatQuantity } from "./programOut";

// DANA ISSUE — the sole's own material, going out for this program.
//
//   Quantity   ● BLACK · EVA  [ 20 ] KG   ● BLUE · EVA  [ 2 ] (BAG) KG   [ Issue Dana ]
//
// Dana is NOT reserved by a program and never has been: a program says which SOLE COLOURS it
// runs, and the operator says how much goes out for it today. So there is no planned figure here
// and no remaining one.
//
// Dana is never labelled and has no bag size to set (owner, 2026-10-11): the operator types a
// QUANTITY in the Dana's own unit — KG, or any unit on its ladder (BAG when 1 BAG = 25 KG is
// set) — and presses Issue. The store's stock is not shown first and does not cap the box:
// whether the store holds that much is the main process's to say, and it refuses an issue larger
// than the stock, by name, moving nothing.
//
// A row per MATERIAL, not per colour. The store can hold EVA BLACK and PVC BLACK at once, and
// "20 KG of BLACK" would not say which left (owner, 2026-10-11). Only the sole colours this
// program runs are offered — the upper colours on it are not Dana.

interface DanaIssuePanelProps {
  programId: string;
  token: string;
  /** Called after stock has moved, so the program and its figures are re-read. */
  onIssued: () => void;
  /** False once the program can take nothing more, so the section is read-only. */
  enabled: boolean;
}

/** What has been typed for one Dana: the amount as text, and the unit it is in. */
interface DanaDraft {
  amount: string;
  unitCode: string;
}

/** Digits and at most one decimal point — "7.5" KG is a real amount of Dana. */
const cleanAmount = (typed: string): string => {
  const kept = typed.replace(/[^0-9.]/g, "");
  const dot = kept.indexOf(".");
  return dot < 0 ? kept : kept.slice(0, dot + 1) + kept.slice(dot + 1).replace(/\./g, "");
};

const DanaRow: React.FC<{
  option: MachineProgramDanaOption;
  draft: DanaDraft;
  disabled: boolean;
  onChange: (draft: DanaDraft) => void;
}> = ({ option, draft, disabled, onChange }) => {
  const blocked = Boolean(option.blockedReason);
  const label = option.subCategoryName ? `${option.colour} · ${option.subCategoryName}` : option.colour;
  return (
    <div className={`mpi-dana-item${blocked ? " is-blocked" : ""}`}>
      <span className="mpi-dana-name">
        <span className="mpi-dana-dot" style={{ background: getColorHex(option.colour) }} aria-hidden="true" />
        {label}
      </span>
      {/* What has already gone out for this program — the database's figure, re-read after every issue. */}
      <span className="mpi-dana-issued">
        {copy.programOut.danaIssuedSoFar(formatQuantity(option.issuedQuantity, option.stockUnitCode))}
      </span>
      {blocked ? <span className="mpi-dana-stock">{copy.programOut.danaScanInstead}</span> : null}
      <div className="mpi-stepper">
        <input
          className="mpi-step-value"
          type="text"
          inputMode="decimal"
          value={draft.amount}
          placeholder="0"
          disabled={disabled || blocked}
          aria-label={copy.programOut.danaQuantityFor(label)}
          onChange={(event) => onChange({ ...draft, amount: cleanAmount(event.target.value) })}
        />
        {/* One unit is simply said; a ladder (BAG / KG) is chosen, in words, never by colour alone. */}
        {option.units.length > 1 ? (
          <span className="mpi-dana-units" role="group" aria-label={copy.programOut.danaUnitFor(label)}>
            {option.units.map((unit) => (
              <button
                key={unit}
                type="button"
                className={`mpi-step mpi-dana-unit${draft.unitCode === unit ? " is-chosen" : ""}`}
                aria-pressed={draft.unitCode === unit}
                disabled={disabled || blocked}
                onClick={() => onChange({ ...draft, unitCode: unit })}
              >
                {unit}
              </button>
            ))}
          </span>
        ) : (
          <span className="mpi-dana-unit-label">{draft.unitCode}</span>
        )}
      </div>
      {blocked ? (
        <p className="mpi-dana-blocked" role="note">
          {option.blockedReason}
        </p>
      ) : null}
    </div>
  );
};

/** The unit a Dana's box starts in: what its stock is counted in, else the first on its ladder. */
const defaultUnit = (option: MachineProgramDanaOption): string => option.stockUnitCode ?? option.units[0] ?? "";

export const DanaIssuePanel: React.FC<DanaIssuePanelProps> = ({ programId, token, onIssued, enabled }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [options, setOptions] = useState<MachineProgramDanaOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DanaDraft>>({});
  const [issuing, setIssuing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.listMachineProgramDanaOptions(programId, { token });
      setOptions(result.accepted ? result.rows : []);
      if (!result.accepted) setError(copy.states.loadFailedBody);
    } catch (caught) {
      setOptions([]);
      setError(caught instanceof Error ? caught.message : copy.states.loadFailedBody);
    }
  }, [api, programId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const draftFor = (option: MachineProgramDanaOption): DanaDraft => drafts[option.itemId] ?? { amount: "", unitCode: defaultUnit(option) };
  const asked = useMemo(
    () => Object.entries(drafts).filter(([, draft]) => Number(draft.amount) > 0),
    [drafts]
  );

  const issue = async () => {
    if (asked.length === 0) return;
    setIssuing(true);
    setError(null);
    try {
      // One material at a time, each its own movement: a refusal on the third must not undo the
      // two that have already physically left the store.
      const failures: string[] = [];
      let moved = 0;
      for (const [itemId, draft] of asked) {
        const result = await api.issueMachineProgramDana(
          { programId, itemId, quantity: Number(draft.amount), unitCode: draft.unitCode },
          { token }
        );
        if (result.accepted) moved += 1;
        else failures.push(result.reason ?? copy.states.loadFailedBody);
      }

      if (moved > 0) {
        push("success", copy.programOut.danaIssuedTitle, copy.programOut.danaIssuedBody(moved));
        setDrafts({});
        await load();
        onIssued();
      }
      if (failures.length > 0) {
        setError(failures[0]);
        push("error", copy.programOut.danaRefusedTitle, failures[0]);
      }
    } finally {
      setIssuing(false);
    }
  };

  return (
    <section className="mpi-section mpi-dana" aria-label={copy.programOut.danaTitle}>
      <header className="mpi-section-head">
        <span className="mpi-section-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M9 2h6v2.2c0 .6.2 1.1.6 1.5l3 3.2A6 6 0 0 1 20 13v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-4a6 6 0 0 1 1.4-4.1l3-3.2c.4-.4.6-.9.6-1.5V2zm2 2v.2c0 1.1-.4 2.2-1.2 3L6.9 10.3A4 4 0 0 0 6 13v4a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-4a4 4 0 0 0-.9-2.7l-2.9-3.1A4.4 4.4 0 0 1 13 4.2V4h-2z" />
          </svg>
        </span>
        <div>
          <h2 className="mpi-section-title">{copy.programOut.danaTitle}</h2>
          <p className="mpi-section-line">{copy.programOut.danaLine}</p>
        </div>
      </header>

      {options === null ? (
        <StateView kind="loading" compact message={copy.common.loading} />
      ) : options.length === 0 ? (
        <StateView kind="empty" compact title={copy.programOut.danaNoneTitle} hint={copy.programOut.danaNoneHint} />
      ) : (
        <div className="mpi-dana-row">
          <span className="mpi-dana-label">{copy.programOut.danaQuantityLabel}</span>
          <div className="mpi-dana-items">
            {options.map((option) => (
              <DanaRow
                key={option.itemId}
                option={option}
                draft={draftFor(option)}
                disabled={issuing || !enabled}
                onChange={(next) => setDrafts((previous) => ({ ...previous, [option.itemId]: next }))}
              />
            ))}
          </div>
          <button
            type="button"
            className="mpi-action mpi-action--dana"
            onClick={() => void issue()}
            disabled={issuing || !enabled || asked.length === 0}
          >
            {issuing ? copy.programOut.danaIssuing : copy.programOut.danaIssue}
          </button>
        </div>
      )}

      {error ? (
        <p className="mpi-error" role="alert">
          ⚠ {error}
        </p>
      ) : null}
    </section>
  );
};
