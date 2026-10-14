import { attributeKey } from "./machineProgram.js";
import { cartonsToDozens } from "./units.js";

// RECONCILIATION (Phase 4) — what went out to a machine program against what came back from it.
//
//   Upper Out            uppers issued to the program's machine on its day, in each material's unit
//   Production Received  the program's carton QRs recorded as produced, in cartons
//
// The two are compared in DOZEN, by the floor's own rule (cartonsExpectedFromUppers, units.ts): a
// dozen of uppers comes back as a dozen of slippers, two cartons of six pairs. Uppers counted in any
// other unit (PAIR, PIECE …) have no rule that turns them into slippers, so they are shown as they are
// and NO difference is given — a figure that would have to be guessed at is refused, not rounded.
//
// The difference is Upper Out − Production Received, in dozens. It is a figure, not a verdict: uppers
// still on the machine, cartons not yet scanned, B cartons and waste all sit inside it.

/** An amount of upper in one stock unit, as the issues carry it. */
export interface UpperAmount {
  unitCode: string;
  quantity: number;
}

export interface UpperProductionComparison {
  /** Uppers issued in DOZEN, the comparable part. */
  upperDozens: number;
  /** Uppers issued in any other unit — shown, never converted. */
  otherUpper: UpperAmount[];
  /** Cartons received, in dozens (cartonsToDozens). */
  receivedDozens: number;
  /** True when every upper issued is in DOZEN, so the two sides are one measure. */
  comparable: boolean;
  /** upperDozens − receivedDozens, or null when the sides are not one measure. */
  differenceDozens: number | null;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

export const compareUpperOutToProduction = (input: { upperOut: UpperAmount[]; receivedCartons: number }): UpperProductionComparison => {
  const dozen = input.upperOut.filter((amount) => attributeKey(amount.unitCode) === "DOZEN");
  const otherUpper = input.upperOut.filter((amount) => attributeKey(amount.unitCode) !== "DOZEN" && amount.quantity !== 0);
  const upperDozens = round(dozen.reduce((total, amount) => total + amount.quantity, 0));
  const receivedDozens = round(cartonsToDozens(Math.max(0, input.receivedCartons)));
  const comparable = otherUpper.length === 0;
  return {
    upperDozens,
    otherUpper,
    receivedDozens,
    comparable,
    differenceDozens: comparable ? round(upperDozens - receivedDozens) : null,
  };
};
