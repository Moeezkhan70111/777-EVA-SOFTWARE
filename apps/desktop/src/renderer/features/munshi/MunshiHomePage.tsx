import React from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
// The operator station chrome — the top bar and the action card — is shared with the store
// station rather than drawn a second time here.
import { StoreTopBar } from "../store/StoreTopBar";
import { StoreActionCard } from "../store/StoreActionCard";
import { StockIcon } from "../store/StoreIcons";
import { GatepassIcon, GatepassListIcon } from "./MunshiIcons";
import { MUNSHI_CARDS, type MunshiAccess } from "./munshiCards";

// The Munshi's station: three big cards, one per job, the same way the store operator's
// screen works.

interface MunshiHomePageProps {
  onNavigate: (route: AppRoute) => void;
  access: MunshiAccess;
}

const CARD_ICON: Record<string, React.ReactNode> = {
  "create-gatepass": <GatepassIcon />,
  "raw-material-stock": <StockIcon />,
  "gatepass-list": <GatepassListIcon />,
};

export const MunshiHomePage: React.FC<MunshiHomePageProps> = ({ onNavigate, access }) => (
  <div className="so-page so-screen so-screen--in">
    {/* Who is signed in is already shown at the foot of the sidebar. */}
    <StoreTopBar title={copy.munshi.title} subtitle={copy.munshi.role} />

    <main className="so-screen-body">
      <div className="so-actions">
        {MUNSHI_CARDS.map((card) => (
          <StoreActionCard
            key={card.id}
            icon={CARD_ICON[card.id]}
            title={card.title}
            line={card.line}
            lockedNote={access[card.needs] ? null : card.lockedNote}
            onSelect={() => onNavigate(card.route)}
            testId={`munshi-action-${card.id}`}
          />
        ))}
      </div>
    </main>
  </div>
);
