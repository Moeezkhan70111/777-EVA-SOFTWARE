import React, { useCallback, useEffect, useMemo, useState } from "react";
import { copy } from "../../../config/copy";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { useNotifications } from "../../../state/NotificationsContext";
import { StateView } from "../../../components/shared/StateView";
import { getColorHex } from "../../../components/shared/ColorSwatch";
import type { MachineProgramDanaOption } from "../../../types/desktopApi";

// DANA ISSUE — the sole's own material, going out for this program.
//
//   Quantity (Bags)   ● BLACK · EVA  [− 0 +]   ● BLACK · PVC  [− 0 +]   [ Issue Dana ]
//
// Dana is NOT reserved by a program and never has been: a program says which SOLE COLOURS it
// runs, and the operator says how many bags go out for it today. So there is no planned figure
// here and no remaining one — only what the store holds and what is being taken.
//
// A row per MATERIAL, not per colour. The store can hold EVA BLACK and PVC BLACK at once, and
// "3 bags of BLACK" would not say which left (owner, 2026-10-11). Only the sole colours this
// program runs are offered — the upper colours on it are not Dana.
//
// Nothing here decides whether the stock may move. The main process converts bags to the
// material's own quantity and hands the movement to the one path a typed quantity leaves the
// store by, which is also what refuses a Dana whose packets carry labels: those are scanned.

interface DanaIssuePanelProps {
  programId: string;
  token: string;
  /** Called after stock has moved, so the program and its figures are re-read. */
  onIssued: () => void;
  /** False once the program can take nothing more, so the section is read-only. */
  enabled: boolean;
}

const Stepper: React.FC<{
  option: MachineProgramDanaOption;
  bags: number;
  disabled: boolean;
  onChange: (bags: number) => void;
}> = ({ option, bags, disabled, onChange }) => {
  const blocked = Boolean(option.blockedReason);
  const label = option.subCategoryName ? `${option.colour} · ${option.subCategoryName}` : option.colour;
  return (
    <div className={`mpi-dana-item${blocked ? " is-blocked" : ""}`}>
      <span className="mpi-dana-name">
        <span className="mpi-dana-dot" style={{ background: getColorHex(option.colour) }} aria-hidden="true" />
        {label}
      </span>
      <span className="mpi-dana-stock">
        {blocked
          ? copy.programOut.danaScanInstead
          : copy.programOut.danaOnHand(option.bagsOnHand, option.packName)}
      </span>
      <div className="mpi-stepper">
        <button
          type="button"
          className="mpi-step"
          onClick={() => onChange(Math.max(0, bags - 1))}
          disabled={disabled || blocked || bags <= 0}
          aria-label={copy.programOut.danaFewer(label)}
        >
          −
        </button>
        <input
          className="mpi-step-value"
          type="text"
          inputMode="numeric"
          value={String(bags)}
          disabled={disabled || blocked}
          aria-label={copy.programOut.danaBagsFor(label)}
          onChange={(event) => {
            const digits = event.target.value.replace(/[^0-9]/g, "");
            onChange(digits === "" ? 0 : Math.min(Number(digits), option.bagsOnHand));
          }}
        />
        <button
          type="button"
          className="mpi-step"
          onClick={() => onChange(Math.min(option.bagsOnHand, bags + 1))}
          disabled={disabled || blocked || bags >= option.bagsOnHand}
          aria-label={copy.programOut.danaMore(label)}
        >
          +
        </button>
      </div>
      {blocked ? (
        <p className="mpi-dana-blocked" role="note">
          {option.blockedReason}
        </p>
      ) : null}
    </div>
  );
};

export const DanaIssuePanel: React.FC<DanaIssuePanelProps> = ({ programId, token, onIssued, enabled }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [options, setOptions] = useState<MachineProgramDanaOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bags, setBags] = useState<Record<string, number>>({});
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

  const asked = useMemo(() => Object.entries(bags).filter(([, count]) => count > 0), [bags]);

  const issue = async () => {
    if (asked.length === 0) return;
    setIssuing(true);
    setError(null);
    try {
      // One material at a time, each its own movement: a refusal on the third must not undo the
      // two bags that have already physically left the store.
      const failures: string[] = [];
      let moved = 0;
      for (const [itemId, count] of asked) {
        const result = await api.issueMachineProgramDana({ programId, itemId, bags: count }, { token });
        if (result.accepted) moved += 1;
        else failures.push(result.reason ?? copy.states.loadFailedBody);
      }

      if (moved > 0) {
        push("success", copy.programOut.danaIssuedTitle, copy.programOut.danaIssuedBody(moved));
        setBags({});
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
              <Stepper
                key={option.itemId}
                option={option}
                bags={bags[option.itemId] ?? 0}
                disabled={issuing || !enabled}
                onChange={(next) => setBags((prev) => ({ ...prev, [option.itemId]: next }))}
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
