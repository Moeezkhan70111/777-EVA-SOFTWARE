import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";

// The two jobs in the store. An operator picks one on Store Station and works only that side:
// everything that comes IN to the store, or everything that goes OUT of it.

export type StoreDirection = "in" | "out";

export interface StoreOperator {
  direction: StoreDirection;
  route: AppRoute;
  /** The digit that picks this card from the keyboard, printed on the card's badge. */
  key: "1" | "2";
  title: string;
  line: string;
}

export const STORE_OPERATORS: readonly StoreOperator[] = [
  {
    direction: "in",
    route: "store-in-operator",
    key: "1",
    title: copy.store.moveInTitle,
    line: copy.store.moveInLine,
  },
  {
    direction: "out",
    route: "store-out-operator",
    key: "2",
    title: copy.store.moveOutTitle,
    line: copy.store.moveOutLine,
  },
];

export const storeOperator = (direction: StoreDirection): StoreOperator =>
  STORE_OPERATORS.find((operator) => operator.direction === direction) ?? STORE_OPERATORS[0];
