import React, { useId } from "react";
import type { AppRoute } from "../../app/routes";
import type { FeatureCardSpec, NavItem } from "./navCatalogue";

// The Home dashboard card: the page's artwork on a soft cloud, a short accent bar, the page's
// name, and a round arrow to go in.
//
//   ┌──────────────────────────────────────┐
//   │        ░░░░ [     artwork     ] ░ ⟋   │
//   │  ▬▬                                   │
//   │  Machine Program                 (→)  │
//   └──────────────────────────────────────┘
//
// Every card is laid out the same way — the name in normal case, its last word in the card's
// accent colour. Only the colour theme differs (theme.css): blue or green. Artwork that already
// carries its own cloud and sparks says so, and the card does not draw them a second time.
//
// The whole card is one button: its accessible name is the page's name, its description the
// one-line summary (visually hidden, as in the design). The artwork, cloud and sparks are
// decoration — the name is what is read (R18).

interface FeatureCardProps {
  item: NavItem;
  feature: FeatureCardSpec;
  onSelect: (route: AppRoute) => void;
}

/** "Machine Program" → ["Machine ", "Program"]: everything before the last word, and the last word. */
const splitTitle = (label: string): [string, string] => {
  const cut = label.lastIndexOf(" ");
  return cut < 0 ? ["", label] : [label.slice(0, cut + 1), label.slice(cut + 1)];
};

const Arrow = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

/** The cloud and three sparks drawn behind artwork that does not bring its own. */
const Scene = () => (
  <>
    <span className="feature-card-cloud" />
    <span className="feature-card-sparks">
      <span />
      <span />
      <span />
    </span>
  </>
);

export const FeatureCard: React.FC<FeatureCardProps> = ({ item, feature, onSelect }) => {
  const [lead, accent] = splitTitle(item.label);
  const lineId = useId();
  return (
    <button
      type="button"
      className={`feature-card feature-card--${feature.theme}`}
      aria-describedby={lineId}
      onClick={() => onSelect(item.route)}
      data-testid={`nav-tile-${item.route}`}
    >
      <span className={`feature-card-art${feature.artworkHasScene ? " feature-card-art--scene" : ""}`} aria-hidden="true">
        {feature.artworkHasScene ? null : <Scene />}
        <img className="feature-card-img" src={feature.artwork} alt="" draggable={false} />
      </span>

      <span className="feature-card-foot">
        <span className="feature-card-text">
          <span className="feature-card-bar" aria-hidden="true" />
          <strong className="feature-card-title">
            {lead}
            <span className="feature-card-title-accent">{accent}</span>
          </strong>
          {/* Hidden from the name, read as the description through aria-describedby. */}
          <span id={lineId} className="sr-only" aria-hidden="true">
            {item.line}
          </span>
        </span>
        <span className="feature-card-go" aria-hidden="true">
          <Arrow />
        </span>
      </span>
    </button>
  );
};
