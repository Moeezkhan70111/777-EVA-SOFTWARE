import React from "react";
import { copy } from "../../config/copy";
import type { LegacyCorrection } from "./legacyColorCorrections";

// Urdu colours this computer learned before the shared list existed, that the list does not yet agree with.
// Shown so nothing learned is lost and no disagreement is settled silently: a person adds each one, or puts it in
// place of what the list says. Hidden when there are none -- on most computers, always.

const text = copy.colorTranslation;

interface LegacyCorrectionsProps {
  corrections: readonly LegacyCorrection[];
  /** Adds a NEW one, or replaces the list's Urdu with a CONFLICT's. */
  onAccept: (correction: LegacyCorrection) => void;
  busy: boolean;
}

export const LegacyCorrections: React.FC<LegacyCorrectionsProps> = ({ corrections, onAccept, busy }) => {
  if (corrections.length === 0) return null;
  return (
    <section className="ct-learned" aria-labelledby="ct-learned-title">
      <h2 id="ct-learned-title" className="ct-learned-title">{text.learnedTitle}</h2>
      <p className="field-help">{text.learnedHint}</p>
      <ul className="ct-learned-list">
        {corrections.map((correction) => (
          <li key={correction.englishKey} className="ct-learned-row">
            <span className="ct-english">{correction.englishKey.toUpperCase()}</span>
            <span className="urdu-text" lang="ur" dir="rtl">{correction.urdu}</span>
            <span className="text-muted">
              {correction.status === "NEW" ? text.learnedNew : (
                <>
                  {text.learnedConflict}{" "}
                  <span className="urdu-text" lang="ur" dir="rtl">{correction.listUrdu}</span>
                </>
              )}
            </span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onAccept(correction)}>
              {correction.status === "NEW" ? text.learnedAdd : text.learnedUse}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
};
