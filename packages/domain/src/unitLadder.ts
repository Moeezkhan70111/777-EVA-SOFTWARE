// A material's own ladder of units, and the arithmetic over it.
//
// NAWAAR is counted in rolls, but a roll of one nawaar is 975 metres and a roll of another is
// not, so "1 ROLL = 975 METRE" is a fact about that material. A ladder is the chain of those
// facts, from the biggest unit down to the smallest:
//
//   1 ROLL  = 975 METRE
//   1 METRE =  40 INCH
//
// The bottom of the chain is the BASE unit, and a material's stock is held in it. So the
// ladder never reinterprets a balance that is already recorded — it lets the same number be
// read and typed in bigger words.
//
// Everything here is pure: the store, the data layer and the screens all do this arithmetic
// the same way because they all do it here.

export interface UnitLadderStep {
  /** One of this… */
  fromUnit: string;
  /** …is `factor` of this. */
  toUnit: string;
  factor: number;
}

/** How much of something there is, said in one unit. */
export interface UnitAmount {
  unit: string;
  quantity: number;
}

/** Every unit on the ladder, biggest first. An empty ladder has no units. */
export const ladderUnits = (steps: readonly UnitLadderStep[]): string[] =>
  steps.length === 0 ? [] : [steps[0]!.fromUnit, ...steps.map((step) => step.toUnit)];

/** The unit a material's stock is held in: the bottom of the chain. */
export const ladderBaseUnit = (steps: readonly UnitLadderStep[]): string | null =>
  steps.length === 0 ? null : steps[steps.length - 1]!.toUnit;

/**
 * What one of each unit is worth in base units — ROLL → 39,000, METRE → 40, INCH → 1.
 * Built by multiplying up from the bottom, so a long chain cannot drift.
 */
export const ladderMultipliers = (steps: readonly UnitLadderStep[]): Map<string, number> => {
  const multipliers = new Map<string, number>();
  const base = ladderBaseUnit(steps);
  if (!base) return multipliers;
  multipliers.set(base, 1);
  let worth = 1;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    worth *= steps[index]!.factor;
    multipliers.set(steps[index]!.fromUnit, worth);
  }
  return multipliers;
};

/**
 * Why this ladder cannot be used, in the words the operator should read. An empty list means
 * it is sound. An empty ladder is sound too — a material is not obliged to have one.
 */
export const ladderProblems = (steps: readonly UnitLadderStep[]): string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();

  steps.forEach((step, index) => {
    if (!step.fromUnit || !step.toUnit) problems.push(`Step ${index + 1} needs both units.`);
    if (step.fromUnit && step.fromUnit === step.toUnit) {
      problems.push(`Step ${index + 1} converts ${step.fromUnit} into itself.`);
    }
    if (!Number.isFinite(step.factor) || step.factor <= 0) {
      problems.push(`Step ${index + 1} needs a number greater than zero.`);
    }
    if (index > 0 && steps[index - 1]!.toUnit !== step.fromUnit) {
      problems.push(`Step ${index + 1} starts at ${step.fromUnit}, but step ${index} ended at ${steps[index - 1]!.toUnit}.`);
    }
  });

  for (const unit of ladderUnits(steps)) {
    if (seen.has(unit)) problems.push(`${unit} appears twice — a ladder cannot loop back on itself.`);
    seen.add(unit);
  }

  return problems;
};

/**
 * A compound count — "2 ROLL and 37 INCH" — as a single number in base units.
 * Units that are not on the ladder are ignored, because they mean nothing for this material.
 */
export const compoundToBase = (steps: readonly UnitLadderStep[], parts: readonly UnitAmount[]): number => {
  const multipliers = ladderMultipliers(steps);
  let total = 0;
  for (const part of parts) {
    const worth = multipliers.get(part.unit);
    if (worth == null || !Number.isFinite(part.quantity)) continue;
    total += part.quantity * worth;
  }
  return total;
};

/**
 * A base-unit total broken back down the ladder — 78,037 INCH becomes 2 ROLL, 0 METRE,
 * 37 INCH. Whole numbers all the way down except the base, which carries any remainder.
 *
 * A negative total keeps its sign on every rung, so "take away 2 ROLL and 37 INCH" reads the
 * way it was typed.
 */
export const baseToCompound = (steps: readonly UnitLadderStep[], baseQuantity: number): UnitAmount[] => {
  const units = ladderUnits(steps);
  if (units.length === 0) return [];
  const multipliers = ladderMultipliers(steps);
  const sign = baseQuantity < 0 ? -1 : 1;
  let left = Math.abs(baseQuantity);

  return units.map((unit, index) => {
    const worth = multipliers.get(unit) ?? 1;
    const isBase = index === units.length - 1;
    const whole = isBase ? left / worth : Math.floor(left / worth);
    left -= whole * worth;
    return { unit, quantity: sign * whole };
  });
};

/**
 * A balance said in the smallest unit on the ladder: 16 RULE where 1 RULE = 975 INCH is
 * 15,600 INCH. This is what a "total quantity" means for a material that is counted in a big
 * unit — the shelf holds 16 rules, and that is 15,600 inches of nawaar.
 *
 * Returns null when the ladder cannot say: no ladder at all, or a unit that is not on it.
 */
export const quantityInBaseUnit = (
  steps: readonly UnitLadderStep[],
  unit: string,
  quantity: number,
): { quantity: number; unit: string } | null => {
  const base = ladderBaseUnit(steps);
  if (!base || base === unit) return null;
  const worth = ladderMultipliers(steps).get(unit);
  if (worth == null || !Number.isFinite(quantity)) return null;
  return { quantity: quantity * worth, unit: base };
};

/** "2 ROLL 37 INCH" — the rungs that are not zero, biggest first. */
export const describeCompound = (parts: readonly UnitAmount[]): string => {
  const spoken = parts.filter((part) => part.quantity !== 0);
  if (spoken.length === 0) return parts.length > 0 ? `0 ${parts[parts.length - 1]!.unit}` : "0";
  return spoken.map((part) => `${Number(part.quantity.toFixed(3))} ${part.unit}`).join(" ");
};

/** "1 ROLL = 975 METRE" — how one rung reads. */
export const describeLadderStep = (step: UnitLadderStep): string =>
  `1 ${step.fromUnit} = ${Number(step.factor.toFixed(3))} ${step.toUnit}`;
