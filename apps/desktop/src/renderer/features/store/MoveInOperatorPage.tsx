import React from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import { StoreOperatorScreen } from "./StoreOperatorScreen";
import { StoreActionCard } from "./StoreActionCard";
import { NewMaterialIcon, QrLabelIcon, ReceiptIcon, ScanInIcon, SetupIcon, StockIcon } from "./StoreIcons";

// The Move In operator's home: one card per thing they can do, three to a row. Each card's
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

interface MoveInCard {
  id: string;
  route: AppRoute;
  icon: React.ReactNode;
  title: string;
  line: string;
  allowed: (access: MoveInAccess) => boolean;
  lockedNote: string;
}

const MOVE_IN_CARDS: MoveInCard[] = [
  { id: "new-material", route: "store-in-new-material", icon: <NewMaterialIcon />, title: copy.store.addMaterialTitle, line: copy.store.addMaterialLine, allowed: (a) => a.stock, lockedNote: copy.store.needsStockAccess },
  { id: "qr-generator", route: "store-in-qr-generator", icon: <QrLabelIcon />, title: copy.store.qrTitle, line: copy.store.qrLine, allowed: (a) => a.labels, lockedNote: copy.store.needsQrAccess },
  { id: "scanner", route: "store-in-scanner", icon: <ScanInIcon />, title: copy.store.scannerTitle, line: copy.store.scannerLine, allowed: () => true, lockedNote: "" },
  { id: "stock", route: "store-in-stock", icon: <StockIcon />, title: copy.store.stockTitle, line: copy.store.stockLine, allowed: (a) => a.stock, lockedNote: copy.store.needsStockAccess },
  { id: "receipts", route: "store-in-receipts", icon: <ReceiptIcon />, title: copy.store.receiptsTitle, line: copy.store.receiptsLine, allowed: (a) => a.stock, lockedNote: copy.store.needsStockAccess },
  { id: "setup", route: "store-in-setup", icon: <SetupIcon />, title: copy.store.setupTitle, line: copy.store.setupLine, allowed: (a) => a.settings, lockedNote: copy.store.needsSettingsAccess },
];

export const MoveInOperatorPage: React.FC<MoveInOperatorPageProps> = ({ onNavigate, access }) => (
  <StoreOperatorScreen direction="in" onBack={() => onNavigate("store-home")}>
    {MOVE_IN_CARDS.map((card) => (
      <StoreActionCard
        key={card.id}
        icon={card.icon}
        title={card.title}
        line={card.line}
        lockedNote={card.allowed(access) ? null : card.lockedNote}
        onSelect={() => onNavigate(card.route)}
        testId={`store-action-${card.id}`}
      />
    ))}
  </StoreOperatorScreen>
);
