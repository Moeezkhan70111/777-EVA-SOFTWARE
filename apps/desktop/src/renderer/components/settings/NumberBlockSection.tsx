import React, { useCallback, useEffect, useState } from "react";
import { StateView } from "../shared/StateView";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { copy } from "../../config/copy";
import type { NumberBlockStatus } from "../../types/desktopApi";

// WHICH DOCUMENT NUMBERS THIS COMPUTER OWNS.
//
// Each computer allocates gatepass, bill, voucher and code numbers from its own range, so two
// computers working offline cannot hand out the same number. This panel shows which range this
// computer holds, and offers the one-time recording of a range while it holds none.
//
// TWO WAYS A RANGE IS RECORDED, and they are not interchangeable:
//
//   adopt   the computer that already holds the company's numbered documents takes range 1,
//           after the data layer proves from that computer's own data that is what it is. It
//           takes no range, because there is nothing to choose.
//   assign  a SECOND computer is given a range from 2 to 5, picked from the list the data layer
//           hands back. Nothing on a computer can tell whether that range is already in use on
//           another machine -- the factory's written record is the authority -- so this is a
//           deliberate act by an administrator, confirmed against the numbers it will create,
//           and the main process refuses range 1 and any reassignment.
//
// No range is worked out here. The numbers shown come from the status, so this panel and the
// assignment it asks for can never disagree about what a range means.

/** The bridge's answer, checked before it is rendered — a missing field must not blank the panel. */
const isStatus = (value: unknown): value is NumberBlockStatus => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.block === null || typeof record.block === "number") &&
    typeof record.confirmed === "boolean" &&
    typeof record.adoption === "object" &&
    record.adoption !== null &&
    Array.isArray(record.assignable)
  );
};

interface NumberBlockSectionProps {
  /** Only an administrator is offered the one-time assignment; the main process requires it too. */
  isAdmin: boolean;
}

export const NumberBlockSection: React.FC<NumberBlockSectionProps> = ({ isAdmin }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [status, setStatus] = useState<NumberBlockStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** The range an administrator picked for a second computer, before they confirm it. */
  const [chosen, setChosen] = useState<AssignableRange | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const answer: unknown = await api.getNumberBlockStatus();
      if (!isStatus(answer)) throw new Error("unexpected shape");
      setStatus(answer);
    } catch {
      setStatus(null);
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const adopt = async (): Promise<string | null> => {
    const result = await api.adoptNumberBlock();
    await load();
    if (!result.accepted) return result.reason ?? copy.numberBlock.adoptRefused;
    push("success", copy.numberBlock.adoptDone, result.range ? copy.numberBlock.numbers(result.range.lo, result.range.hi) : undefined);
    return null;
  };

  const assign = async (range: AssignableRange): Promise<string | null> => {
    const result = await api.assignNumberBlock(range.block);
    await load();
    if (!result.accepted) return result.reason ?? copy.numberBlock.assignRefused;
    push(
      "success",
      copy.numberBlock.assignDone,
      result.range ? copy.numberBlock.numbers(result.range.lo, result.range.hi) : undefined
    );
    return null;
  };

  const body = () => {
    if (failed) return <StateView kind="error" compact message={copy.numberBlock.loadFailed} onRetry={() => void load()} />;
    if (!status) return <StateView kind="loading" compact />;
    return (
      <NumberBlockFacts
        status={status}
        isAdmin={isAdmin}
        onAdopt={() => setConfirming(true)}
        onAssign={setChosen}
      />
    );
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">{copy.numberBlock.title}</div>
      {body()}
      {confirming && (
        <ConfirmDialog
          title={copy.numberBlock.adoptAction}
          facts={[
            { label: copy.numberBlock.computerLabel, value: copy.numberBlock.computer(1) },
            { label: copy.numberBlock.rangeLabel, value: copy.numberBlock.numbers(1, 99_999) },
          ]}
          explain={copy.numberBlock.adoptConfirm}
          confirmLabel={copy.numberBlock.adoptAction}
          tone="primary"
          onConfirm={adopt}
          onClose={() => setConfirming(false)}
        />
      )}
      {chosen !== null && (
        // THE NUMBERS ARE SHOWN BEFORE ANYTHING IS RECORDED, because this is the one decision an
        // administrator has to check against a record the application cannot see.
        <ConfirmDialog
          title={copy.numberBlock.assignAction}
          facts={[
            { label: copy.numberBlock.computerLabel, value: copy.numberBlock.computer(chosen.block) },
            { label: copy.numberBlock.rangeLabel, value: copy.numberBlock.numbers(chosen.lo, chosen.hi) },
          ]}
          explain={copy.numberBlock.assignConfirm(chosen.block, chosen.lo, chosen.hi)}
          confirmLabel={copy.numberBlock.assignAction}
          tone="primary"
          onConfirm={() => assign(chosen)}
          onClose={() => setChosen(null)}
        />
      )}
    </div>
  );
};

// ─── what the panel actually shows ──────────────────────────────────────────

const STATE_BADGE: Record<"ok" | "warn" | "err", string> = {
  ok: copy.numberBlock.configured,
  warn: copy.numberBlock.notConfigured,
  err: copy.numberBlock.invalid,
};

const NumberBlockFacts: React.FC<{
  status: NumberBlockStatus;
  isAdmin: boolean;
  onAdopt: () => void;
  onAssign: (range: AssignableRange) => void;
}> = ({ status, isAdmin, onAdopt, onAssign }) => {
  const tone = status.problem === null ? "ok" : status.problem === "INVALID" ? "err" : "warn";
  const canAdopt = isAdmin && status.adoption.allowed;
  // Offered while the data layer says a range may still be given here. An administrator who is
  // not offered it is told why, below, rather than shown a control that would refuse.
  const canAssign = isAdmin && status.assignable.length > 0;

  return (
    <>
      <div className="settings-grid">
        <div className="input-group">
          <span className="input-label">{copy.numberBlock.stateLabel}</span>
          <span className={`badge badge-${tone}`}>{STATE_BADGE[tone]}</span>
        </div>
        <div className="input-group">
          <span className="input-label">{copy.numberBlock.computerLabel}</span>
          <span>{status.block === null ? copy.common.none : copy.numberBlock.computer(status.block)}</span>
        </div>
        <div className="input-group">
          <span className="input-label">{copy.numberBlock.rangeLabel}</span>
          <span>{status.range ? copy.numberBlock.numbers(status.range.lo, status.range.hi) : copy.common.none}</span>
        </div>
      </div>

      {status.problem === "NOT_CONFIGURED" && <p role="status">⚠ {copy.numberBlock.notConfiguredBody}</p>}
      {status.problem === "INVALID" && (
        <p role="alert">
          ⚠ {copy.numberBlock.invalidBody}
          {status.storedValue ? ` ${copy.numberBlock.storedValue(status.storedValue)}` : ""}
        </p>
      )}

      {canAdopt && (
        <button type="button" className="btn btn-primary" onClick={onAdopt}>
          {copy.numberBlock.adoptAction}
        </button>
      )}
      {/* A computer that cannot work its own range out is told so plainly, rather than offered a
          button that would refuse. The detail comes from the data layer's check. */}
      {!status.adoption.allowed && status.adoption.refusal !== "ALREADY_CONFIGURED" && (
        <p role="status">
          <strong>{copy.numberBlock.cannotAssignTitle}</strong> {status.adoption.detail}
        </p>
      )}

      {canAssign && <AssignRange ranges={status.assignable} onAssign={onAssign} />}
    </>
  );
};

/** One range from the data layer's own list. Never built here. */
type AssignableRange = NumberBlockStatus["assignable"][number];

/**
 * Picking a range for a second computer. A select of exactly the ranges the data layer offers,
 * rather than a number field: the valid set is four values, and a typo on this control would be
 * recorded once and never changed in the application.
 */
const AssignRange: React.FC<{
  ranges: readonly AssignableRange[];
  onAssign: (range: AssignableRange) => void;
}> = ({ ranges, onAssign }) => {
  const [block, setBlock] = useState("");
  const picked = ranges.find((range) => String(range.block) === block) ?? null;

  return (
    // settings-section again for the sub-block, as CloudSyncSection does for its parked queue:
    // existing spacing, no new class invented for one panel.
    <div className="settings-section">
      <p role="status">
        <strong>{copy.numberBlock.assignTitle}</strong> {copy.numberBlock.assignBody}
      </p>
      <div className="input-group">
        <label className="input-label" htmlFor="number-block-choice">
          {copy.numberBlock.assignLabel}
        </label>
        <select
          id="number-block-choice"
          className="input"
          value={block}
          onChange={(event) => setBlock(event.target.value)}
        >
          <option value="">{copy.numberBlock.assignChoose}</option>
          {ranges.map((range) => (
            <option key={range.block} value={String(range.block)}>
              {`${copy.numberBlock.computer(range.block)} — ${copy.numberBlock.numbers(range.lo, range.hi)}`}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={picked === null}
        onClick={() => picked !== null && onAssign(picked)}
      >
        {copy.numberBlock.assignAction}
      </button>
    </div>
  );
};
