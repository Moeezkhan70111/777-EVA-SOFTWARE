import React, { useMemo, useState } from "react";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { StateView } from "../../components/shared/StateView";

// The one way Machine Program asks "which one?": a grid of large cards, never a dropdown.
//
// Used for the contractor, the sole, the sole colour, the article and the size, so every question
// looks and behaves the same and the operator learns it once. A search box appears only when the
// list is long enough for scanning it to be work — a floor with four soles never sees one.
//
// The chosen card is obvious three ways: a tick, a filled border, and aria-pressed (R18).

export interface Choice {
  key: string;
  title: string;
  /** A second line under the title — a city, a quantity of Dana. */
  sub?: string;
  /**
   * A physical product colour this choice stands for (BLACK, NAVY …). Drawn as a dot beside
   * the title, which always names it too, so colour is never the only cue (R18).
   */
  swatch?: string;
  disabled?: boolean;
}

interface ChoiceCardsProps {
  choices: Choice[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Large tiles for few short names (sizes, soles), wider ones for longer text. */
  size?: "large" | "wide";
  /** Shown above the cards once there are more than `searchFrom` of them. */
  searchLabel?: string;
  searchFrom?: number;
  noMatch?: string;
  empty?: { title: string; hint?: string };
}

const DEFAULT_SEARCH_FROM = 12;

export const ChoiceCards: React.FC<ChoiceCardsProps> = ({
  choices,
  selectedKey,
  onSelect,
  size = "large",
  searchLabel,
  searchFrom = DEFAULT_SEARCH_FROM,
  noMatch,
  empty,
}) => {
  const [search, setSearch] = useState("");
  const showSearch = Boolean(searchLabel) && choices.length > searchFrom;

  const shown = useMemo(() => {
    const needle = search.trim().toUpperCase();
    if (!needle) return choices;
    return choices.filter((choice) => `${choice.title} ${choice.sub ?? ""}`.toUpperCase().includes(needle));
  }, [choices, search]);

  if (choices.length === 0 && empty) {
    return <StateView kind="empty" compact title={empty.title} hint={empty.hint} />;
  }

  return (
    <div className="mp-choices">
      {showSearch ? (
        <input
          type="search"
          className="form-input mp-choices-search"
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : null}

      {shown.length === 0 ? (
        <StateView kind="empty" compact title={noMatch} />
      ) : (
        <div className={`mp-choice-grid mp-choice-grid--${size}`}>
          {shown.map((choice) => {
            const selected = choice.key === selectedKey;
            return (
              <button
                key={choice.key}
                type="button"
                className={`mp-choice${selected ? " is-selected" : ""}`}
                aria-pressed={selected}
                disabled={choice.disabled}
                onClick={() => onSelect(choice.key)}
              >
                {selected ? <span className="mp-choice-mark" aria-hidden="true">✓</span> : null}
                <span className="mp-choice-title">
                  {choice.swatch ? <ColorSwatch color={choice.swatch} className="mp-choice-swatch" /> : null}
                  {choice.title}
                </span>
                {choice.sub ? <span className="mp-choice-sub">{choice.sub}</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
