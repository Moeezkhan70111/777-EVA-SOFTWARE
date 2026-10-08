import React, { useCallback, useEffect, useState } from "react";
import { baseToCompound, describeCompound, ladderProblems, ladderUnits, quantityInBaseUnit } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { ItemUnitLadder, UnitLadderPreset } from "../../types/desktopApi";
import { Modal } from "./Modal";
import { AddUnitModal } from "./AddUnitModal";
import { copy } from "../../config/copy";
import { ladderSteps } from "./CompoundQuantityInput";

// How this material is counted.
//
// Two separate things, in the order the store runs into them:
//
//   1. The unit the count is IN. If 62 was always 62 rules and INCH was picked by mistake,
//      the unit is corrected — the figure is NOT converted, it is relabelled, and it carries a
//      reason because re-stamping every recorded movement is not something to do by accident.
//   2. What that unit contains: 1 RULE = 975 METER, 1 METER = 39.7 INCH. A chain like that is
//      true of a whole family of nawaar, so it can be saved as a named set and reused, and
//      pushed to every colour of this same material in one go.

interface UnitLadderSectionProps {
  itemId: string;
  /** Every unit that exists, to count in and to build rungs from. */
  units: Array<Record<string, unknown>>;
  /** What is in store now, in the unit the stock is held in. */
  onHand: number;
  /** Re-reads the list: the unit and the ladder both show on the Stock tab. */
  onChanged: () => Promise<void>;
}

interface DraftStep {
  fromUnitId: string;
  toUnitId: string;
  factor: string;
}

export const UnitLadderSection: React.FC<UnitLadderSectionProps> = ({ itemId, units, onHand, onChanged }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [ladder, setLadder] = useState<ItemUnitLadder | null>(null);
  const [draft, setDraft] = useState<DraftStep[]>([]);
  const [presets, setPresets] = useState<UnitLadderPreset[]>([]);
  const [siblings, setSiblings] = useState<Array<{ id: string; displayName: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  /** The unit being switched to, waiting for a reason. */
  const [changingUnitId, setChangingUnitId] = useState("");
  const [unitReason, setUnitReason] = useState("");
  /** Change every colour of this material at the same time. On by default: they are counted
   *  the same way, and doing them one at a time is how two colours end up disagreeing. */
  const [unitForAllColours, setUnitForAllColours] = useState(true);
  const [presetName, setPresetName] = useState("");
  const [naming, setNaming] = useState(false);
  /** Open while a new unit is being made. Units live here now: the setup panel that used to
   *  hold them was removed, and this is where one is actually chosen. */
  const [addingUnit, setAddingUnit] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [result, savedSets, colours] = await Promise.all([
        api.getInventoryItemUnitLadder(itemId),
        api.listUnitLadderPresets(),
        api.inventoryItemColourSiblings(itemId),
      ]);
      const next = result.accepted ? (result.ladder ?? null) : null;
      setLadder(next);
      setPresets(savedSets);
      setSiblings(colours);
      setDraft(
        (next?.steps ?? []).map((step) => ({
          fromUnitId: step.fromUnitId,
          toUnitId: step.toUnitId,
          factor: String(step.factor),
        })),
      );
    } finally {
      setLoading(false);
    }
  }, [api, itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const unitCode = (id: string) => String(units.find((unit) => String(unit.id) === id)?.code ?? "");

  const changeUnit = async (): Promise<void> => {
    setSaving(true);
    try {
      const result = await api.correctInventoryItemUnit({
        itemId,
        unitId: changingUnitId,
        reason: unitReason.trim(),
        alsoColours: unitForAllColours && siblings.length > 0,
      });
      if (!result.accepted) {
        push("error", copy.toast.failed, result.reason ?? copy.common.unknownError);
        return;
      }
      const skipped = result.colours?.skipped ?? [];
      push(
        skipped.length > 0 ? "info" : "success",
        copy.units.unitChanged(unitCode(changingUnitId)),
        (result.colours?.applied ?? 0) > 0
          ? copy.units.unitChangedColours(result.colours!.applied) +
              (skipped.length > 0 ? ` ${skipped.map((row) => `${row.displayName}: ${row.reason}`).join(" · ")}` : "")
          : undefined,
      );
      setChangingUnitId("");
      setUnitReason("");
      await load();
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  const addStep = () => {
    const last = draft[draft.length - 1];
    setDraft([...draft, { fromUnitId: last ? last.toUnitId : (ladder?.stockUnitId ?? ""), toUnitId: "", factor: "" }]);
  };

  const setStep = (index: number, patch: Partial<DraftStep>) =>
    setDraft(draft.map((step, position) => (position === index ? { ...step, ...patch } : step)));

  const removeStep = (index: number) => setDraft(draft.filter((_, position) => position !== index));

  const usePreset = (presetId: string) => {
    const preset = presets.find((row) => row.id === presetId);
    if (!preset) return;
    setDraft(preset.steps.map((step) => ({ fromUnitId: step.fromUnitId, toUnitId: step.toUnitId, factor: String(step.factor) })));
  };

  const stepsForSave = () =>
    draft.map((step) => ({ fromUnitId: step.fromUnitId, toUnitId: step.toUnitId, factor: Number(step.factor) }));

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.setInventoryItemUnitLadder({ itemId, steps: stepsForSave() });
      if (!result.accepted) {
        push("error", copy.toast.failed, result.reason ?? copy.common.unknownError);
        return;
      }
      push("success", copy.units.saved);
      setLadder(result.ladder ?? null);
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  const savePreset = async (): Promise<void> => {
    const result = await api.saveUnitLadderPreset({ name: presetName.trim(), steps: stepsForSave() });
    if (!result.accepted) {
      push("error", copy.toast.failed, result.reason ?? copy.common.unknownError);
      return;
    }
    push("success", copy.units.presetSaved(presetName.trim()));
    setPresetName("");
    setNaming(false);
    setPresets(await api.listUnitLadderPresets());
  };

  const applyToColours = async () => {
    setSaving(true);
    try {
      const result = await api.applyUnitLadderToColours(itemId);
      if (!result.accepted) {
        push("error", copy.toast.failed, result.reason ?? copy.common.unknownError);
        return;
      }
      const skipped = result.skipped ?? [];
      push(
        skipped.length > 0 ? "info" : "success",
        copy.units.appliedToColours(result.applied ?? 0),
        skipped.length > 0 ? skipped.map((row) => `${row.displayName}: ${row.reason}`).join(" · ") : undefined,
      );
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  // Judged by the same rules the data layer judges it by, so the button never promises
  // something the save would refuse.
  const problems = ladderProblems(
    draft.map((step) => ({ fromUnit: unitCode(step.fromUnitId), toUnit: unitCode(step.toUnitId), factor: Number(step.factor) })),
  );
  const draftUnits = ladderUnits(
    draft.map((step) => ({ fromUnit: unitCode(step.fromUnitId), toUnit: unitCode(step.toUnitId), factor: Number(step.factor) })),
  );
  const missesStockUnit =
    draft.length > 0 && problems.length === 0 && Boolean(ladder?.stockUnit) && !draftUnits.includes(ladder!.stockUnit!);
  const blocked = problems.length > 0 || missesStockUnit;

  // The balance is kept in the stock unit, which may sit anywhere on the chain — 19 RULE, not
  // 19 of the smallest unit. So it goes down to the base first, then back up into words.
  const inWords = (() => {
    if (!ladder || ladder.steps.length === 0 || !ladder.stockUnit) return null;
    const steps = ladderSteps(ladder);
    const base = quantityInBaseUnit(steps, ladder.stockUnit, onHand);
    return describeCompound(baseToCompound(steps, base ? base.quantity : onHand));
  })();

  return (
    <section className="rm-drawer-section" data-testid="unit-ladder">
      <h3 className="rm-drawer-heading">{copy.units.howCounted}</h3>

      {loading ? (
        <p className="field-help">{copy.common.loading}</p>
      ) : (
        <>
          {/* 1 — the unit the count is in. */}
          <div className="rm-ladder-unit-row">
            <label className="input-label" htmlFor={`rm-unit-${itemId}`}>
              {copy.units.countedIn}
            </label>
            <select
              id={`rm-unit-${itemId}`}
              className="form-input"
              value={ladder?.stockUnitId ?? ""}
              data-testid="unit-ladder-stock-unit"
              onChange={(event) => setChangingUnitId(event.target.value)}
            >
              <option value="">{copy.units.pick}</option>
              {units.map((unit) => (
                <option key={String(unit.id)} value={String(unit.id)}>
                  {String(unit.code)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid="unit-ladder-add-unit"
              onClick={() => setAddingUnit(true)}
            >
              {copy.units.addUnit}
            </button>
          </div>
          <p className="field-help">{copy.units.countedInExplain(onHand, ladder?.stockUnit ?? "")}</p>

          {/* 2 — what that unit contains. */}
          {inWords ? (
            <p className="rm-ladder-total" data-testid="unit-ladder-total">
              {copy.units.inStoreThatIs} <strong>{inWords}</strong>
            </p>
          ) : null}

          {presets.length > 0 ? (
            <div className="rm-ladder-unit-row">
              <label className="input-label" htmlFor={`rm-preset-${itemId}`}>
                {copy.units.useSaved}
              </label>
              <select
                id={`rm-preset-${itemId}`}
                className="form-input"
                value=""
                data-testid="unit-ladder-preset"
                onChange={(event) => usePreset(event.target.value)}
              >
                <option value="">{copy.units.pickSaved}</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="rm-ladder-steps">
            {draft.map((step, index) => (
              <div className="rm-ladder-step" key={index}>
                <span className="rm-ladder-one">1</span>
                <select
                  className="form-input"
                  aria-label={`Step ${index + 1} — bigger unit`}
                  value={step.fromUnitId}
                  onChange={(event) => setStep(index, { fromUnitId: event.target.value })}
                >
                  <option value="">{copy.units.pick}</option>
                  {units.map((unit) => (
                    <option key={String(unit.id)} value={String(unit.id)}>
                      {String(unit.code)}
                    </option>
                  ))}
                </select>
                <span className="rm-ladder-equals" aria-hidden="true">
                  =
                </span>
                <input
                  type="number"
                  step="any"
                  min="0"
                  className="form-input rm-ladder-factor"
                  aria-label={`Step ${index + 1} — how many`}
                  value={step.factor}
                  onChange={(event) => setStep(index, { factor: event.target.value })}
                />
                <select
                  className="form-input"
                  aria-label={`Step ${index + 1} — smaller unit`}
                  value={step.toUnitId}
                  onChange={(event) => setStep(index, { toUnitId: event.target.value })}
                >
                  <option value="">{copy.units.pick}</option>
                  {units.map((unit) => (
                    <option key={String(unit.id)} value={String(unit.id)}>
                      {String(unit.code)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`Remove step ${index + 1}`}
                  onClick={() => removeStep(index)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {problems.length > 0 ? (
            <p className="rm-danger-reason" role="status">
              ⚠ {problems[0]}
            </p>
          ) : missesStockUnit ? (
            <p className="rm-danger-reason" role="status">
              ⚠ {copy.units.mustInclude(ladder?.stockUnit ?? "")}
            </p>
          ) : null}

          <div className="rm-correction-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={addStep} data-testid="unit-ladder-add">
              {copy.units.addStep}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={saving || blocked}
              data-testid="unit-ladder-save"
              onClick={() => void save()}
            >
              {saving ? copy.common.saving : copy.common.save}
            </button>
            {draft.length > 0 && !blocked ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNaming(true)} data-testid="unit-ladder-save-preset">
                {copy.units.saveAsSet}
              </button>
            ) : null}
            {siblings.length > 0 && (ladder?.steps.length ?? 0) > 0 ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={saving}
                data-testid="unit-ladder-apply-colours"
                onClick={() => void applyToColours()}
              >
                {copy.units.applyToColours(siblings.length)}
              </button>
            ) : null}
          </div>
        </>
      )}

      {/* Changing the unit re-stamps every recorded movement, so it asks why first. */}
      {changingUnitId ? (
        <Modal
          title={copy.units.changeUnitTitle(ladder?.stockUnit ?? "", unitCode(changingUnitId))}
          subtitle={copy.units.changeUnitExplain}
          onClose={() => {
            setChangingUnitId("");
            setUnitReason("");
          }}
          footer={
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || unitReason.trim() === ""}
              data-testid="unit-change-confirm"
              onClick={() => void changeUnit()}
            >
              {saving ? copy.common.saving : copy.units.changeUnitConfirm}
            </button>
          }
        >
          <p className="field-help">
            {copy.units.inStoreNow}: <strong>{onHand} {ladder?.stockUnit ?? ""}</strong> → {copy.units.willRead}:{" "}
            <strong>
              {onHand} {unitCode(changingUnitId)}
            </strong>
          </p>
          <p className="rm-danger-reason">⚠ {copy.units.changeUnitWarning}</p>
          {siblings.length > 0 ? (
            <label className="inv-cat-check-label">
              <input
                type="checkbox"
                checked={unitForAllColours}
                data-testid="unit-change-all-colours"
                onChange={(event) => setUnitForAllColours(event.target.checked)}
              />
              {copy.units.alsoColours(siblings.length)}
            </label>
          ) : null}

          <div className="form-group">
            <label className="input-label" htmlFor={`rm-unit-reason-${itemId}`}>
              {copy.units.changeUnitReason}
              <span className="required-mark"> *</span>
            </label>
            <input
              id={`rm-unit-reason-${itemId}`}
              className="form-input"
              autoFocus
              value={unitReason}
              placeholder="e.g. entered as inches, they were always rules"
              onChange={(event) => setUnitReason(event.target.value)}
            />
          </div>
        </Modal>
      ) : null}

      {addingUnit ? (
        <AddUnitModal
          onClose={() => setAddingUnit(false)}
          onCreated={async () => {
            setAddingUnit(false);
            await onChanged();
          }}
        />
      ) : null}

      {naming ? (
        <Modal
          title={copy.units.saveAsSet}
          subtitle={copy.units.saveAsSetExplain}
          onClose={() => setNaming(false)}
          footer={
            <button
              type="button"
              className="btn btn-primary"
              disabled={presetName.trim() === ""}
              data-testid="unit-preset-confirm"
              onClick={() => void savePreset()}
            >
              {copy.common.save}
            </button>
          }
        >
          <ul className="rm-ladder-preview">
            {draft.map((step, index) => (
              <li key={index}>
                1 {unitCode(step.fromUnitId)} = {step.factor} {unitCode(step.toUnitId)}
              </li>
            ))}
          </ul>
          <div className="form-group">
            <label className="input-label" htmlFor={`rm-preset-name-${itemId}`}>
              {copy.units.setName}
              <span className="required-mark"> *</span>
            </label>
            <input
              id={`rm-preset-name-${itemId}`}
              className="form-input"
              autoFocus
              value={presetName}
              placeholder="e.g. NAWAAR rule to inch"
              onChange={(event) => setPresetName(event.target.value)}
            />
          </div>
        </Modal>
      ) : null}

    </section>
  );
};
