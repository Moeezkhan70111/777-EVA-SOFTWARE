import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";

// The three jobs on the Munshi's station, in the order they appear on the screen.
//
// Each card opens a screen that already exists and keeps that screen's own permission: the
// Munshi permission decides that this person works from a station instead of the navbar, not
// what they are allowed to do. A card the Munshi may not use stays visible but disabled and
// says why in words, so nobody wonders where a button went (R18).

/** What this Munshi's permissions allow, as the cards need to know it. */
export interface MunshiAccess {
  /** Creating a gatepass and reading the gatepass list. */
  gatepass: boolean;
  /** Reading raw material store stock. */
  stock: boolean;
}

export interface MunshiCard {
  id: string;
  route: AppRoute;
  title: string;
  line: string;
  /** Which part of `MunshiAccess` this card needs. */
  needs: keyof MunshiAccess;
  lockedNote: string;
}

export const MUNSHI_CARDS: readonly MunshiCard[] = [
  {
    id: "create-gatepass",
    route: "gatepass",
    title: copy.munshi.gatepassTitle,
    line: copy.munshi.gatepassLine,
    needs: "gatepass",
    lockedNote: copy.munshi.needsGatepassAccess,
  },
  {
    id: "raw-material-stock",
    route: "munshi-stock",
    title: copy.munshi.stockTitle,
    line: copy.munshi.stockLine,
    needs: "stock",
    lockedNote: copy.munshi.needsStockAccess,
  },
  {
    id: "gatepass-list",
    route: "gatepass-list",
    title: copy.munshi.listTitle,
    line: copy.munshi.listLine,
    needs: "gatepass",
    lockedNote: copy.munshi.needsGatepassAccess,
  },
];

/** The screens a Munshi reaches from a card that bring no station chrome of their own. */
export const MUNSHI_FRAMED_ROUTES: ReadonlySet<AppRoute> = new Set<AppRoute>(["gatepass", "gatepass-list"]);
