import React from "react";
import { fromPaisa, isValidContractorRatePaisa, toPaisa, type ContractorRates } from "@erp/domain";
import type { MachineProgramArticleRate } from "../../types/desktopApi";
import { copy } from "../../config/copy";

// CONTRACTOR PRICING — the three rates one article's work is paid at, per DOZEN.
//
//   Machine rate      Packing rate     Printing rate
//   [ 45.00 ]         [ 18.00 ]        [ 12.00 ]        per DOZEN
//
// One component for both places they are typed: while an article is being added to a program
// (AddArticleDialog), and when the program's pricing is changed afterwards
// (ContractorPricingDialog). The rates themselves mean the same thing in both, so they are
// entered, checked and worded the same way in both.
//
// Nothing here is a second rule about money. What a rate may be is the domain's
// (isValidContractorRatePaisa) and the conversion to paisa is the domain's (toPaisa); this only
// holds what was typed and says out loud why it cannot be saved. Every save is checked again in
// the main process.

/** The three rates as typed — strings, so a half-typed number is never read as one. */
export interface RateDraft {
  machine: string;
  packing: string;
  printing: string;
}

export const EMPTY_RATE_DRAFT: RateDraft = { machine: "", packing: "", printing: "" };

/** The rates stored against an article, as the boxes show them. */
export const rateDraftOf = (rates: MachineProgramArticleRate | ContractorRates | null | undefined): RateDraft =>
  rates
    ? {
        machine: String(fromPaisa(rates.machineRatePaisa)),
        packing: String(fromPaisa(rates.packingRatePaisa)),
        printing: String(fromPaisa(rates.printingRatePaisa)),
      }
    : EMPTY_RATE_DRAFT;

/** True when nothing has been typed into any of the three boxes. */
export const isEmptyRateDraft = (draft: RateDraft): boolean =>
  draft.machine.trim() === "" && draft.packing.trim() === "" && draft.printing.trim() === "";

/** An empty box is zero: "not paid for this article" is a real answer, and the only one left. */
const rupeesOf = (typed: string): number => (typed.trim() === "" ? 0 : Number(typed));

/** What the save sends: rupees as typed, which the main process converts and validates. */
export const rateDraftToRupees = (draft: RateDraft): { machineRate: number; packingRate: number; printingRate: number } => ({
  machineRate: rupeesOf(draft.machine),
  packingRate: rupeesOf(draft.packing),
  printingRate: rupeesOf(draft.printing),
});

/** The draft as whole paisa, for comparing it with what is already stored. */
export const rateDraftToPaisa = (draft: RateDraft): ContractorRates => {
  const rupees = rateDraftToRupees(draft);
  return {
    machineRatePaisa: toPaisa(rupees.machineRate),
    packingRatePaisa: toPaisa(rupees.packingRate),
    printingRatePaisa: toPaisa(rupees.printingRate),
  };
};

export const sameRates = (a: ContractorRates, b: ContractorRates): boolean =>
  a.machineRatePaisa === b.machineRatePaisa &&
  a.packingRatePaisa === b.packingRatePaisa &&
  a.printingRatePaisa === b.printingRatePaisa;

/** Why a draft cannot be saved, in the operator's words — or null when it can. */
export const rateDraftProblem = (draft: RateDraft): string | null => {
  const typed = [draft.machine, draft.packing, draft.printing];
  if (typed.some((value) => value.trim() !== "" && !Number.isFinite(Number(value)))) {
    return copy.machineProgram.rateNotANumber;
  }
  const paisa = rateDraftToPaisa(draft);
  const kinds = [paisa.machineRatePaisa, paisa.packingRatePaisa, paisa.printingRatePaisa];
  return kinds.every((value) => isValidContractorRatePaisa(value)) ? null : copy.machineProgram.rateOutOfRange;
};

interface ContractorRateFieldsProps {
  value: RateDraft;
  onChange: (next: RateDraft) => void;
  /** Makes the three input ids unique when several articles are priced on one screen. */
  idPrefix: string;
  disabled?: boolean;
  /** Laid out in a row by default; `stacked` fits the narrow column of a pricing table row. */
  layout?: "row" | "stacked";
}

export const ContractorRateFields: React.FC<ContractorRateFieldsProps> = ({
  value,
  onChange,
  idPrefix,
  disabled = false,
  layout = "row",
}) => {
  const field = (
    key: keyof RateDraft,
    label: string
  ): React.ReactNode => (
    <div className="mpr-field" key={key}>
      <label className="mpr-label" htmlFor={`${idPrefix}-${key}`}>
        {label}
      </label>
      <div className="mpr-input-wrap">
        <span className="mpr-currency" aria-hidden="true">
          {copy.machineProgram.rupeePrefix}
        </span>
        <input
          id={`${idPrefix}-${key}`}
          className="mpr-input"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={value[key]}
          disabled={disabled}
          placeholder="0.00"
          autoComplete="off"
          onChange={(event) => onChange({ ...value, [key]: event.target.value })}
        />
      </div>
    </div>
  );

  return (
    <div className={`mpr-fields mpr-fields--${layout}`}>
      {field("machine", copy.machineProgram.machineRate)}
      {field("packing", copy.machineProgram.packingRate)}
      {field("printing", copy.machineProgram.printingRate)}
      <p className="mpr-per">{copy.machineProgram.perDozen}</p>
    </div>
  );
};
