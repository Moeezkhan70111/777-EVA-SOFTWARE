import React from "react";
import { SearchableCombobox, type SearchableComboboxOption } from "../../../components/shared/SearchableCombobox";
import { copy } from "../../../config/copy";
import type { RawMaterialHandMoveOptions } from "../../../types/desktopApi";
import { formatQuantity } from "../../rawMaterial/rawMaterial";
import { inStockUnit, type DraftLine } from "./voucherDraft";

// One line of the voucher being written:
//
//   2  [ NAWAAR · 5 SOOTAR · BLACK ▾ ]  [ 3    ]  [ RULE ▾ ]  = 2,925 INCH   ✕
//
// The unit list is the material's own ladder; the figure after "=" is what the balance will move by. Moving out, until a
// different unit is chosen, the figure is what the store holds.

interface VoucherLineRowProps {
  line: DraftLine;
  lineNo: number;
  itemOptions: SearchableComboboxOption[];
  options: RawMaterialHandMoveOptions | undefined;
  problem: string | null;
  /** Moving out: what the store can give for this material, in its stock unit. Null moving in. */
  available: number | null;
  /** Only the last, empty line cannot be removed: it is where the next material goes. */
  removable: boolean;
  disabled: boolean;
  onChooseItem: (itemId: string) => void;
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: () => void;
}

export const VoucherLineRow: React.FC<VoucherLineRowProps> = (props) => {
  const { line, lineNo, itemOptions, options, problem, available, removable, disabled, onChooseItem, onChange, onRemove } = props;
  const words = copy.handVoucher;
  const converted = inStockUnit(options, line);
  const stockUnit = options?.stockUnitCode ?? "";
  const reading = Boolean(line.itemId) && !options;

  return (
    <li className={`siv-line${problem ? " has-problem" : ""}`}>
      <span className="siv-line-no" aria-hidden="true">{lineNo}</span>
      <div className="siv-line-material">
        <SearchableCombobox
          value={line.itemId}
          searchPlaceholder={copy.store.searchMaterial}
          options={itemOptions}
          placeholder={itemOptions.length === 0 ? copy.moveOut.noMaterials : copy.moveOut.chooseMaterial}
          emptyLabel={copy.moveOut.noMaterialMatch}
          ariaLabel={words.materialFor(lineNo)}
          onChange={onChooseItem}
        />
      </div>
      <input
        className="form-input siv-line-qty"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0"
        aria-label={words.quantityFor(lineNo)}
        aria-invalid={problem ? true : undefined}
        value={line.quantity}
        disabled={disabled}
        onChange={(event) => onChange({ quantity: event.target.value.replace(",", ".") })}
      />
      <select
        className="form-input siv-line-unit"
        aria-label={words.unitFor(lineNo)}
        value={line.unitCode}
        disabled={disabled || !options || options.units.length <= 1}
        onChange={(event) => onChange({ unitCode: event.target.value })}
      >
        {options ? null : <option value="">{reading ? words.loadingMaterial : words.unit}</option>}
        {(options?.units ?? []).map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>
      <span className="siv-line-equals" aria-live="polite">
        {lineFigure(converted, line.unitCode, stockUnit, available)}
      </span>
      <button type="button" className="siv-line-remove" aria-label={words.removeLine(lineNo)} title={words.removeLine(lineNo)} disabled={disabled || !removable} onClick={onRemove}>
        ✕
      </button>
      {problem ? (
        <p className="siv-line-problem" role="alert">
          ⚠ {problem}
        </p>
      ) : null}
    </li>
  );
};

/** Beside the unit: what the typed figure comes to in the stock unit, or — moving out — what the store holds. */
const lineFigure = (converted: number | null, unit: string, stockUnit: string, available: number | null): string => {
  const words = copy.handVoucher;
  if (converted != null && unit !== stockUnit) return words.stockEquals(formatQuantity(converted), stockUnit);
  if (available != null) return words.inStore(formatQuantity(available), stockUnit);
  return "";
};
