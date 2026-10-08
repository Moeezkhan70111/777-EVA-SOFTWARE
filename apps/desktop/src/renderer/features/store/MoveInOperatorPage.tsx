import React from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import { StoreOperatorScreen } from "./StoreOperatorScreen";
import { StoreActionCard } from "./StoreActionCard";
import { MOVE_IN_PAGES } from "./storeOperators";
import { NewMaterialIcon, QrLabelIcon, ReceiptIcon, ScanInIcon, SetupIcon, StockIcon } from "./StoreIcons";

// The Move In operator's home: one card per thing they can do, three to a row. The pages
// themselves are listed once, in storeOperators.ts, which the sidebar reads too. Each card's
// permission is the one the main process already checks for that action; an operator without
// it still sees the card, disabled, with the reason in words.

export interface MoveInAccess {
  /** Creating a material, Stock and Receipts. */
  stock: boolean;
  /** Printing raw material QR labels. */
  labels: boolean;
  /** Categories, units, conversions and destinations. */
  settings: boolean;
}

interface MoveInOperatorPageProps {
  onNavigate: (route: AppRoute) => void;
  access: MoveInAccess;
}

/** What each Move In page needs, in this screen's terms, and what a locked card says. */
const CARD_RULES: Record<string, { icon: React.ReactNode; allowed: (access: MoveInAccess) => boolean; lockedNote: string }> = {
  "new-material": { icon: <NewMaterialIcon />, allowed: (a) => a.stock, lockedNote: copy.store.needsStockAccess },
  "qr-generator": { icon: <QrLabelIcon />, allowed: (a) => a.labels, lockedNote: copy.store.needsQrAccess },
  scanner: { icon: <ScanInIcon />, allowed: () => true, lockedNote: "" },
  stock: { icon: <StockIcon />, allowed: (a) => a.stock, lockedNote: copy.store.needsStockAccess },
  receipts: { icon: <ReceiptIcon />, allowed: (a) => a.stock, lockedNote: copy.store.needsStockAccess },
  setup: { icon: <SetupIcon />, allowed: (a) => a.settings, lockedNote: copy.store.needsSettingsAccess },
};

export const MoveInOperatorPage: React.FC<MoveInOperatorPageProps> = ({ onNavigate, access }) => (
  <StoreOperatorScreen direction="in" onBack={() => onNavigate("store-home")}>
    {MOVE_IN_PAGES.map((page) => {
      const rules = CARD_RULES[page.id];
      return (
        <StoreActionCard
          key={page.id}
          icon={rules?.icon}
          title={page.title}
          line={page.line}
          lockedNote={!rules || rules.allowed(access) ? null : rules.lockedNote}
          onSelect={() => onNavigate(page.route)}
          testId={`store-action-${page.id}`}
        />
      );
    })}
  </StoreOperatorScreen>
);
