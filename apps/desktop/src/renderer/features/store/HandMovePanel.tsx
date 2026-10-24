import React, { useCallback, useEffect, useMemo, useState } from "react";
import { convertOnLadder, type UnitLadderStep } from "@erp/domain";
import type { HandMoveDirection, Party, RawMaterialHandMoveOptions } from "../../types/desktopApi";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { StepHeading } from "../../components/shared/StepHeading";
import { copy } from "../../config/copy";
import { materialPickerOption, formatQuantity, type InventoryItemRow } from "../rawMaterial/rawMaterial";

// MOVING MATERIAL BY HAND — for loose stock that carries no label, in either direction.
//
//   ① Supplier          [ SHEHZAD RUBBER ▾ ]            (moving IN only)
//   ② Select Material   [ NAWAAR · 5 SOOTAR · BLACK ▾ ]  In store: 1,950 INCH
//   ③ How much
//        [ RULE ] [ INCH ]          every rung of this material's own ladder
//        [ 700 ]  INCH  =  0.718 RULE
//
// Nawaar comes off a roll with a knife and arrives on one with no label, so the only way to
// move it is to say what went or what came. The operator may say it on ANY rung of the
// material's ladder — 1 RULE and 975 INCH are the same amount for a 975-inch rule — and the
// line under the box shows what the figure comes to everywhere else, so it can be checked
// before it is sent.
//
// Receiving is supplier-at-a-time, the same rule a scanning session follows, so moving IN asks
// who delivered it. Moving OUT does not — but it must say what the stock is going out for
// (required since 0.3.6), because a hand move has no label or scan to say where it went.
//
// Nothing here decides anything. The arithmetic is the domain's (convertOnLadder), the units
// are the material's own, and every refusal comes back from the data layer, which checks the
// same rules again — a form that hides a rule is not a rule (R9).

interface HandMovePanelProps {
  /** Which way material is going. IN asks for the supplier; OUT caps at what is in store. */
  direction: HandMoveDirection;
  /** Session token; the main process authorises the move with it. */
  token: string;
  /** Called once stock has actually moved. */
  onMoved?: () => void;
}

export const HandMovePanel: React.FC<HandMovePanelProps> = ({ direction, token, onMoved }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const movingIn = direction === "IN";
  const words = movingIn ? copy.moveOut.inWords : copy.moveOut.outWords;

  const [items, setItems] = useState<InventoryItemRow[]>([]);
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [partyId, setPartyId] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [itemId, setItemId] = useState("");
  const [options, setOptions] = useState<RawMaterialHandMoveOptions | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [unit, setUnit] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [moving, setMoving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setLoadError(null);
    try {
      const [materials, parties] = await Promise.all([
        api.listInventoryItems({}),
        movingIn ? api.listParties({ pageSize: 1000 }) : Promise.resolve({ rows: [] as Party[] }),
      ]);
      setItems(materials);
      setSuppliers(parties.rows.filter((party) => party.partyType === "SUPPLIER"));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    }
  }, [api, movingIn]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  /** What the store may offer for this material — read again after every move. */
  const loadOptions = useCallback(
    async (nextItemId: string) => {
      if (!nextItemId) {
        setOptions(null);
        return;
      }
      setLoadingOptions(true);
      try {
        const next = await api.getRawMaterialHandMoveOptions(nextItemId, direction, { token });
        setOptions(next);
        // Start on the unit the BALANCE is kept in, which is the figure shown just above the
        // box: what the operator reads and what they type then mean the same thing. Any other
        // rung is one tap away.
        setUnit((current) => {
          if (next?.units.includes(current)) return current;
          const stock = next?.stockUnitCode ?? "";
          return next?.units.includes(stock) ? stock : (next?.units[0] ?? "");
        });
      } catch (error) {
        setOptions(null);
        push("error", copy.toast.loadFailed, error instanceof Error ? error.message : copy.states.loadFailedBody);
      } finally {
        setLoadingOptions(false);
      }
    },
    [api, direction, push, token]
  );

  const chooseItem = (nextItemId: string) => {
    setItemId(nextItemId);
    setQuantity("");
    setRefusal(null);
    void loadOptions(nextItemId);
  };

  const itemOptions = useMemo(
    () => items.filter((item) => item.id && item.display_name).map(materialPickerOption),
    [items]
  );
  const supplierOptions = useMemo(
    () => suppliers.map((party) => ({ value: party.id, label: `${party.partyCode} — ${party.partyName}` })),
    [suppliers]
  );

  const steps: UnitLadderStep[] = useMemo(
    () => (options?.steps ?? []).map((step) => ({ fromUnit: step.fromUnit, toUnit: step.toUnit, factor: step.factor })),
    [options]
  );
  /** The step numbers shift by one when the supplier is asked for first. */
  const stepNo = (base: 1 | 2): number => (movingIn ? base + 1 : base);

  const typed = quantity.trim() === "" ? Number.NaN : Number(quantity);
  const stockUnit = options?.stockUnitCode ?? "";
  /** What the typed figure comes to in the unit the balance is kept in. */
  const inStockUnit =
    options && unit && Number.isFinite(typed) && typed > 0
      ? unit === stockUnit
        ? typed
        : convertOnLadder(steps, typed, unit, stockUnit)
      : null;

  // Only a move OUT is capped: the shelf cannot give what it does not hold.
  const tooMuch = !movingIn && inStockUnit != null && options != null && Number(inStockUnit.toFixed(3)) > options.quantityOnHand;
  const problem = problemOf({ options, typed, quantity, inStockUnit, tooMuch, stockUnit, words });
  // Moving OUT must say what for; moving IN's reference stays optional. The data layer refuses a
  // move out without it too, so this only saves the operator a round trip.
  const noteRequired = !movingIn;
  const purposeMissing = noteRequired && note.trim() === "";
  const ready = Boolean(
    options && !options.blockedReason && unit && inStockUnit != null && !problem && !moving && (!movingIn || partyId) && !purposeMissing
  );

  const move = async () => {
    if (!ready || !options) return;
    setMoving(true);
    setRefusal(null);
    try {
      const result = await api.moveRawMaterialByHand(
        {
          itemId: options.itemId,
          direction,
          quantity: typed,
          unitCode: unit,
          partyId: movingIn ? partyId : null,
          note: note.trim() || null,
        },
        { token }
      );
      if (!result.accepted) {
        setRefusal(result.reason ?? copy.states.loadFailedBody);
        return;
      }
      push(
        "success",
        words.movedTitle,
        words.movedBody(formatQuantity(result.typedQuantity ?? typed), result.typedUnitCode ?? unit, options.displayName)
      );
      setQuantity("");
      setNote("");
      await loadOptions(options.itemId);
      onMoved?.();
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : copy.states.loadFailedBody);
    } finally {
      setMoving(false);
    }
  };

  return (
    <form
      className="mo-manual"
      onSubmit={(event) => {
        event.preventDefault();
        void move();
      }}
    >
      {movingIn ? (
        <section className="qr-step">
          <StepHeading index={1} done={Boolean(partyId)} title={copy.moveOut.stepSupplier} />
          <div className="qr-step-body">
            <SearchableCombobox
              dropdown
              value={partyId}
              options={supplierOptions}
              placeholder={supplierOptions.length === 0 ? copy.moveOut.noSuppliers : copy.moveOut.chooseSupplier}
              emptyLabel={copy.moveOut.noSupplierMatch}
              ariaLabel={copy.moveOut.stepSupplier}
              onChange={setPartyId}
            />
            <p className="field-help">{copy.moveOut.supplierHelp}</p>
          </div>
        </section>
      ) : null}

      <section className="qr-step">
        <StepHeading index={stepNo(1)} done={Boolean(options)} title={copy.moveOut.stepMaterial} />
        <div className="qr-step-body">
          {loadError ? (
            <StateView kind="error" compact message={loadError} onRetry={() => void loadItems()} />
          ) : (
            <>
              <SearchableCombobox
                dropdown
                value={itemId}
                options={itemOptions}
                placeholder={itemOptions.length === 0 ? copy.moveOut.noMaterials : copy.moveOut.chooseMaterial}
                emptyLabel={copy.moveOut.noMaterialMatch}
                ariaLabel={copy.moveOut.stepMaterial}
                onChange={chooseItem}
              />
              {options ? <InStore options={options} /> : <p className="field-help">{copy.moveOut.materialHelp}</p>}
            </>
          )}
        </div>
      </section>

      <section className="qr-step">
        <StepHeading index={stepNo(2)} done={inStockUnit != null && !problem} title={words.stepAmount} />
        <div className="qr-step-body">
          {!options ? (
            <StateView kind="empty" compact title={copy.moveOut.chooseMaterialFirst} />
          ) : loadingOptions ? (
            <StateView kind="loading" compact />
          ) : options.blockedReason ? (
            <p className="qr-error" role="alert">
              ⚠ {options.blockedReason}
            </p>
          ) : (
            <>
              <p className="mo-field-label">{copy.moveOut.unitLabel}</p>
              <div className="mo-units" role="group" aria-label={copy.moveOut.unitLabel}>
                {options.units.map((code: string) => (
                  <button
                    key={code}
                    type="button"
                    className={`mo-unit${code === unit ? " is-active" : ""}`}
                    aria-pressed={code === unit}
                    onClick={() => setUnit(code)}
                  >
                    {code}
                    {code === stockUnit ? <span className="mo-unit-note">{copy.moveOut.stockUnitNote}</span> : null}
                  </button>
                ))}
              </div>

              <label className="mo-field-label" htmlFor="mo-quantity">
                {copy.moveOut.quantityLabel}
              </label>
              <div className="mo-amount">
                <input
                  id="mo-quantity"
                  className="form-input mo-quantity"
                  inputMode="decimal"
                  autoComplete="off"
                  value={quantity}
                  aria-invalid={problem ? true : undefined}
                  onChange={(event) => {
                    setQuantity(event.target.value.replace(",", "."));
                    setRefusal(null);
                  }}
                />
                <span className="mo-amount-unit">{unit}</span>
              </div>

              <Equivalents steps={steps} units={options.units} unit={unit} typed={typed} stockUnit={stockUnit} inStockUnit={inStockUnit} />

              <label className="mo-field-label" htmlFor="mo-note">
                {words.noteLabel}
                {noteRequired ? (
                  <span className="required-mark"> *</span>
                ) : (
                  <> <span className="text-muted">{copy.moveOut.optional}</span></>
                )}
              </label>
              <input
                id="mo-note"
                className="form-input"
                value={note}
                maxLength={160}
                autoComplete="off"
                required={noteRequired}
                aria-required={noteRequired || undefined}
                placeholder={words.notePlaceholder}
                onChange={(event) => setNote(event.target.value)}
              />
              {purposeMissing && inStockUnit != null ? (
                <p className="field-help">{copy.moveOut.outWords.noteMissing}</p>
              ) : null}
            </>
          )}
        </div>
      </section>

      {problem ? (
        <p className="qr-error" role="alert">
          ⚠ {problem}
        </p>
      ) : null}
      {refusal ? (
        <p className="mp-problem" role="alert">
          ⚠ {refusal}
        </p>
      ) : null}

      <div className="mo-commit">
        <button type="submit" className="btn btn-primary btn-lg" disabled={!ready}>
          {moving ? words.moving : words.action}
        </button>
      </div>
    </form>
  );
};

/** What is on the shelf, said in the unit the balance is kept in. */
const InStore: React.FC<{ options: RawMaterialHandMoveOptions }> = ({ options }) => (
  <p className="mo-in-store">
    <span className="mo-in-store-label">{copy.moveOut.inStore}</span>
    <b>
      {formatQuantity(options.quantityOnHand)} {options.stockUnitCode ?? ""}
    </b>
  </p>
);

/**
 * The typed figure said on every other rung — "700 INCH = 0.718 RULE" — so the operator can
 * check it against the roll in front of them before anything moves.
 */
const Equivalents: React.FC<{
  steps: UnitLadderStep[];
  units: string[];
  unit: string;
  typed: number;
  stockUnit: string;
  inStockUnit: number | null;
}> = ({ steps, units, unit, typed, stockUnit, inStockUnit }) => {
  if (inStockUnit == null || !Number.isFinite(typed) || typed <= 0) {
    return <p className="field-help">{copy.moveOut.amountHelp}</p>;
  }
  const others = units
    .filter((code) => code !== unit)
    .map((code) => ({ code, amount: code === stockUnit ? inStockUnit : convertOnLadder(steps, typed, unit, code) }))
    .filter((entry): entry is { code: string; amount: number } => entry.amount != null);

  return (
    <p className="mo-equals" aria-live="polite">
      <b>
        {formatQuantity(typed)} {unit}
      </b>
      {others.map((entry) => (
        <span key={entry.code}>
          = {formatQuantity(entry.amount)} {entry.code}
          {entry.code === stockUnit ? ` ${copy.moveOut.offTheBalance}` : ""}
        </span>
      ))}
    </p>
  );
};

/** Why the form cannot be sent yet, in the operator's words. An empty box is not an error. */
const problemOf = (input: {
  options: RawMaterialHandMoveOptions | null;
  typed: number;
  quantity: string;
  inStockUnit: number | null;
  tooMuch: boolean;
  stockUnit: string;
  words: { quantityInvalid: string };
}): string | null => {
  const { options, typed, quantity, inStockUnit, tooMuch, stockUnit, words } = input;
  if (!options || options.blockedReason || quantity.trim() === "") return null;
  if (!Number.isFinite(typed) || typed <= 0) return words.quantityInvalid;
  if (inStockUnit == null) return copy.moveOut.cannotConvert;
  if (tooMuch) return copy.moveOut.notEnough(formatQuantity(options.quantityOnHand), stockUnit, formatQuantity(Number(inStockUnit.toFixed(3))));
  return null;
};
