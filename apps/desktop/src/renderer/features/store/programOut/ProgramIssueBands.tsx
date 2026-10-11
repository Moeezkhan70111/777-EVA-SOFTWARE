import React from "react";
import { copy } from "../../../config/copy";
import { StateView } from "../../../components/shared/StateView";
import { formatQuantity, type ProgramBand, type ProgramCard } from "./programOut";

// What the program authorises, as the floor reads it.
//
//   ┌ Injector 1 │ Sole Color : BLACK ───────────────────────────────────────┐
//   │ ┌ SK30 7/10   20 / 20  Completed ┐ ┌ SK12 7/10  10 / 30  In Progress ┐ │
//   │ │ ████████████████████████████   │ │ ██████████                      │ │
//   │ │ Upper Colour  Planned Issued R │ │ …                               │ │
//   │ │ BLACK RED      10     10     0 │ │                                 │ │
//
// A card per ARTICLE + SIZE under the sole it is moulded on, because that is the thing being
// made; the lines inside it are the upper colours going onto it. The same grouping as the
// printed sheet, so the paper on the machine and this screen cannot be read differently.
//
// Every figure here is the data layer's, recomputed from the event log after each scan. The one
// thing worked out on screen is the bar's width, which is the two figures printed beside it.

const STATE_LABEL: Record<ProgramCard["state"], string> = {
  PENDING: copy.programOut.statePending,
  IN_PROGRESS: copy.programOut.stateInProgress,
  DONE: copy.programOut.stateDone,
};

const CARTON_STATE_LABEL: Record<ProgramCard["cartonState"], string> = {
  PENDING: copy.programOut.cartonStatePending,
  IN_PROGRESS: copy.programOut.cartonStateInProgress,
  DONE: copy.programOut.cartonStateDone,
};

/**
 * Which figures a card reads in. Store Out takes uppers OUT, so it counts dozens planned, issued
 * and remaining. Store In takes cartons BACK, so it counts cartons due for what was issued (3
 * DOZEN = 6), back, and still to come.
 */
export type ProgramCardMode = "issue" | "cartons";

/** The figures one card shows, whichever way it is read. */
const cardFigures = (card: ProgramCard, mode: ProgramCardMode) =>
  mode === "issue"
    ? { done: card.issued, total: card.planned, state: card.state, word: STATE_LABEL[card.state], label: copy.programOut.cardProgressLabel }
    : {
        done: card.cartonsBack,
        total: card.cartonsDue,
        state: card.cartonState,
        word: CARTON_STATE_LABEL[card.cartonState],
        label: copy.programOut.cartonCardProgressLabel,
      };

/** "BLACK RED": the sole is black and the upper going on it is red. */
const LineName: React.FC<{ soleColour: string; upperColour: string }> = ({ soleColour, upperColour }) => (
  <th scope="row">
    <span className="mpi-sole-of">{soleColour}</span> <span className="mpi-upper-of">{upperColour}</span>
  </th>
);

/** Nothing left is the good outcome, so it is the quiet one. */
const Remaining: React.FC<{ value: number }> = ({ value }) => (
  <td className={`mpi-num ${value > 0 ? "mpi-owed" : "mpi-clear"}`}>{value}</td>
);

const IssueTable: React.FC<{ card: ProgramCard; soleColour: string }> = ({ card, soleColour }) => (
  <table className="mpi-card-table">
    <thead>
      <tr>
        <th scope="col">{copy.programOut.colUpperColour}</th>
        <th scope="col" className="mpi-num">{copy.programOut.colPlanned(card.unitCode)}</th>
        <th scope="col" className="mpi-num">{copy.programOut.colIssued}</th>
        <th scope="col" className="mpi-num">{copy.programOut.colRemaining}</th>
      </tr>
    </thead>
    <tbody>
      {card.lines.map((line) => (
        <tr key={line.key}>
          <LineName soleColour={soleColour} upperColour={line.upperColour} />
          <td className="mpi-num">{line.planned}</td>
          <td className="mpi-num">{line.issued}</td>
          <Remaining value={line.remaining} />
        </tr>
      ))}
    </tbody>
  </table>
);

const CartonTable: React.FC<{ card: ProgramCard; soleColour: string }> = ({ card, soleColour }) => (
  <table className="mpi-card-table">
    <thead>
      <tr>
        <th scope="col">{copy.programOut.colUpperColour}</th>
        <th scope="col" className="mpi-num">{copy.programOut.colCartonsDue}</th>
        <th scope="col" className="mpi-num">{copy.programOut.colCartonsBack}</th>
        <th scope="col" className="mpi-num">{copy.programOut.colCartonsToCome}</th>
      </tr>
    </thead>
    <tbody>
      {card.lines.map((line) => (
        <tr key={line.key}>
          <LineName soleColour={soleColour} upperColour={line.upperColour} />
          {/* "—" when the upper is not counted in whole cartons of DOZEN: no figure is invented. */}
          <td className="mpi-num">{line.cartonsDue ?? "—"}</td>
          <td className="mpi-num">{line.cartonsBack}</td>
          <Remaining value={Math.max(0, (line.cartonsDue ?? 0) - line.cartonsBack)} />
        </tr>
      ))}
    </tbody>
  </table>
);

const ArticleCard: React.FC<{ card: ProgramCard; soleColour: string; mode: ProgramCardMode }> = ({ card, soleColour, mode }) => {
  const figures = cardFigures(card, mode);
  const share = figures.total > 0 ? Math.min(1, figures.done / figures.total) : 0;
  return (
    <section className={`mpi-card mpi-card--${figures.state.toLowerCase()}`}>
      <header className="mpi-card-head">
        <span className="mpi-card-article">{card.article}</span>
        <span className="mpi-card-size">{card.size}</span>
        <span className="mpi-card-count">
          {figures.done} / {figures.total}
        </span>
        {/* The word, not just the bar and the colour. */}
        <span className={`mpi-pill mpi-pill--sm mpi-pill--${figures.state.toLowerCase()}`}>{figures.word}</span>
      </header>

      <div
        className="mpi-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={figures.total}
        aria-valuenow={figures.done}
        aria-label={figures.label(card.article, card.size)}
      >
        <span className="mpi-bar-fill" style={{ width: `${Math.round(share * 100)}%` }} />
      </div>

      {mode === "issue" ? <IssueTable card={card} soleColour={soleColour} /> : <CartonTable card={card} soleColour={soleColour} />}
    </section>
  );
};

interface ProgramIssueBandsProps {
  bands: ProgramBand[];
  /** Store Out reads uppers issued; Store In reads cartons coming back. */
  mode?: ProgramCardMode;
}

export const ProgramIssueBands: React.FC<ProgramIssueBandsProps> = ({ bands, mode = "issue" }) => {
  if (bands.length === 0) {
    return <StateView kind="empty" compact title={copy.programOut.noLines} hint={copy.programOut.noLinesHint} />;
  }
  return (
    <>
      {bands.map((band) => (
        <section className="mpi-band" key={band.key} aria-label={copy.programOut.bandLabel(band.injectorNo, band.soleColour)}>
          <header className="mpi-band-head">
            <span className="mpi-band-no">{copy.machineProgram.injector(band.injectorNo)}</span>
            <span className="mpi-band-sole">
              {copy.machineProgram.printSoleColour} : <b>{band.soleColour}</b>
            </span>
          </header>
          <div className="mpi-cards">
            {band.cards.map((card) => (
              <ArticleCard card={card} soleColour={band.soleColour} mode={mode} key={card.key} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
};

/** The two figures the whole program comes to, with the same marks the printed sheet uses. */
export const ProgramIssueTotals: React.FC<{ injectors: number; total: number; unitCode: string | null }> = ({
  injectors,
  total,
  unitCode,
}) => (
  <dl className="mpi-totals">
    <div className="mpi-total">
      <span className="mpi-total-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M3 3h4v6.2l5-2.8v2.8l5-2.8v2.8l5-2.8V21H3V3zm3 12v3h3v-3H6zm5 0v3h3v-3h-3z" />
        </svg>
      </span>
      <div className="mpi-total-words">
        <dt>{copy.machineProgram.printTotalInjectors}</dt>
        <dd>{injectors}</dd>
      </div>
    </div>
    <div className="mpi-total">
      <span className="mpi-total-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M12 2 3 7v10l9 5 9-5V7l-9-5zm0 2.3 6.4 3.6L12 11.5 5.6 7.9 12 4.3zM5 9.6l6 3.4v6.7l-6-3.3V9.6zm8 10.1V13l6-3.4v6.8l-6 3.3z" />
        </svg>
      </span>
      <div className="mpi-total-words">
        <dt>{copy.programOut.totalUpperLabel(unitCode)}</dt>
        <dd>{formatQuantity(total, null)}</dd>
      </div>
    </div>
  </dl>
);
