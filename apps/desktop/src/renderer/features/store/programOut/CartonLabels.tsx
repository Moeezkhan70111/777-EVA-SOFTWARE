import React from "react";
import { copy } from "../../../config/copy";
import { ColorSwatch } from "../../../components/shared/ColorSwatch";
import type { MachineProgramCartonPacket, MachineProgramFixCartonRun } from "../../../types/desktopApi";
import { cartonLabelTotals, cartonRunLabel, type CartonRun, type PrintedCartonRun } from "./programOut";

// CARTONS TO LABEL — a job to do, said as one.
//
//   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
//   ┃ ▣  ACTION NEEDED                                                        ┃
//   ┃    Print 64 carton QR labels                                            ┃
//   ┃    1 article is waiting for labels. Print them before production starts.┃
//   ┃    ① Print the labels  →  ② Stick one on every carton  →  ③ Store In…   ┃
//   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
//   ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
//   ╎ ●  DC3 / 7/10 / SILVER GREY            64        [ 🖨 Print 64 labels ] ╎
//   ╎    One QR label per carton             cartons                         ╎
//   └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
//   PRINTED
//   ✓ SK12 / 7/10 / BLACK RED   ✓ Printed · SK12_…_000001 → …_000008  ▬▬▬ 3 of 8 back  [Reprint]
//
// The banner changes with the state — labels owed (blue, the steps), all printed (green, how many
// are back), nothing yet or closed (calm) — so the first thing read is what to do next. A run owed
// labels is drawn like a label to cut out: dashed edge, its colour, a big count, one big button.
//
// The runs and their counts come from the main process (see programOut.ts); nothing is worked out
// here but how many labels the banner should name.

interface CartonRunListProps {
  runs: CartonRun[];
  printed: PrintedCartonRun[];
  /** The run being generated right now, by key, so only its own button says so. */
  printingKey: string | null;
  onPrint: (run: CartonRun) => void;
  /** Prints a printed run's labels again — the same codes, for a label torn or lost. */
  onReprint: (run: PrintedCartonRun) => void;
  /** The program is closed: no new labels are printed for it (a reprint creates nothing, so it stays). */
  locked?: boolean;
  /** Packets whose cartons the main process could not work out, with its reason. */
  blocked: MachineProgramCartonPacket[];
  /** FIX runs whose cartons could not be worked out — same refusals, no packet to name. */
  blockedFix?: MachineProgramFixCartonRun[];
}

const text = copy.programOut;

const QrIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm8-2h2v2h-2v-2zm4 0h4v2h-2v2h-2v-4zm-4 4h2v4h-2v-4zm4 2h2v2h2v-4h2v6h-6v-4z" />
  </svg>
);

const PrinterIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 3h10v5H7V3zM5 9h14a3 3 0 0 1 3 3v5h-4v4H6v-4H2v-5a3 3 0 0 1 3-3zm3 7v3h8v-3H8zm10-4.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z" />
  </svg>
);

/** A thin bar for "how many are back" — the words beside it carry the figure (R18). */
const BackBar: React.FC<{ back: number; total: number }> = ({ back, total }) => (
  <span className="mpo-back-bar" aria-hidden="true">
    <span className="mpo-back-bar-fill" style={{ width: `${total > 0 ? Math.round(Math.min(1, back / total) * 100) : 0}%` }} />
  </span>
);

/** The banner: what to do next, in the state the program's labels are in. */
const CartonHero: React.FC<{ pendingRuns: number; locked: boolean; totals: { owed: number; printed: number; back: number } }> = ({
  pendingRuns,
  locked,
  totals,
}) => {
  if (pendingRuns > 0 && !locked) {
    return (
      <div className="mpo-hero mpo-hero--todo" role="status">
        <span className="mpo-hero-icon"><QrIcon /></span>
        <div className="mpo-hero-words">
          <span className="mpo-hero-eyebrow">{text.cartonHeroEyebrow}</span>
          <p className="mpo-hero-title">{text.cartonHeroTitle(totals.owed)}</p>
          <p className="mpo-hero-body">{text.cartonHeroBody(pendingRuns)}</p>
        </div>
        <ol className="mpo-hero-steps">
          {text.cartonSteps.map((step, index) => (
            <li key={step}>
              <span className="mpo-hero-step-no">{index + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (totals.printed > 0 && !locked) {
    return (
      <div className="mpo-hero mpo-hero--done" role="status">
        <span className="mpo-hero-icon"><CheckIcon /></span>
        <div className="mpo-hero-words">
          <p className="mpo-hero-title">{text.cartonDoneTitle}</p>
          <p className="mpo-hero-body">{text.cartonDoneBody}</p>
          <span className="mpo-hero-back">
            <BackBar back={totals.back} total={totals.printed} />
            {text.cartonDoneBack(totals.back, totals.printed)}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="mpo-hero mpo-hero--quiet">
      <span className="mpo-hero-icon"><QrIcon /></span>
      <div className="mpo-hero-words">
        <p className="mpo-hero-title">{locked ? text.cartonLockedTitle : text.cartonEmptyTitle}</p>
        <p className="mpo-hero-body">{locked ? text.cartonLockedBody : text.cartonEmpty}</p>
      </div>
    </div>
  );
};

/** One run still owed its labels, drawn like a label to cut out. */
const LabelTicket: React.FC<{ run: CartonRun; printing: boolean; disabled: boolean; onPrint: () => void }> = ({ run, printing, disabled, onPrint }) => (
  <li className="mpo-ticket">
    <ColorSwatch color={run.colour} className="mpo-ticket-swatch" />
    <span className="mpo-ticket-what">
      <span className="mpo-ticket-name">{cartonRunLabel(run)}</span>
      <span className="mpo-ticket-hint">{text.cartonOneEach}</span>
    </span>
    <span className="mpo-ticket-count">
      <b>{run.cartons}</b>
      <span>{text.cartonsWord(run.cartons)}</span>
    </span>
    <button
      type="button"
      className="btn btn-primary mpo-ticket-print"
      onClick={onPrint}
      disabled={disabled}
      aria-label={text.cartonPrintLabel(run.cartons, cartonRunLabel(run))}
    >
      <PrinterIcon />
      {printing ? text.cartonPrinting : text.cartonPrintCount(run.cartons)}
    </button>
  </li>
);

/** One run already labelled: its codes, how many are back, and Reprint for a lost label. */
const PrintedRow: React.FC<{ run: PrintedCartonRun; printing: boolean; disabled: boolean; onReprint: () => void }> = ({ run, printing, disabled, onReprint }) => (
  <li className="mpo-printed">
    <span className="mpo-printed-tick"><CheckIcon /></span>
    <span className="mpo-printed-what">
      <span className="mpo-printed-name">
        {run.grade === "B" ? <span className="mpo-b-badge" aria-label={text.cartonBBadgeLabel}>B</span> : null}
        {run.label}
      </span>
      <span className="mpo-printed-range">{text.cartonPrinted(run.range)}</span>
      {run.voided ? <span className="mpo-printed-converted">{text.cartonConvertedToB(run.voided)}</span> : null}
    </span>
    <span className="mpo-printed-back">
      <BackBar back={run.received} total={run.cartons} />
      <span className="mpo-carton-back">{text.cartonBack(run.received, run.cartons)}</span>
    </span>
    <button
      type="button"
      className="btn btn-secondary mpo-printed-reprint"
      onClick={onReprint}
      disabled={disabled}
      aria-label={text.cartonReprintLabel(run.label)}
    >
      {printing ? text.cartonReprinting : text.cartonReprint}
    </button>
  </li>
);

export const CartonRunList: React.FC<CartonRunListProps> = ({ runs, printed, printingKey, onPrint, onReprint, blocked, blockedFix = [], locked = false }) => (
  <section className="mpo-batch mpo-labels" aria-label={text.cartonTitle}>
    <header className="mpo-labels-head">
      <h3 className="mpo-batch-title">{text.cartonTitle}</h3>
      <span className="mpo-labels-note">{text.cartonNote}</span>
    </header>

    <CartonHero pendingRuns={runs.length} locked={locked} totals={cartonLabelTotals(runs, printed)} />

    {runs.length > 0 ? (
      <ul className="mpo-tickets">
        {runs.map((run) => (
          <LabelTicket
            key={run.key}
            run={run}
            printing={printingKey === run.key}
            disabled={printingKey !== null || locked}
            onPrint={() => onPrint(run)}
          />
        ))}
      </ul>
    ) : null}

    {blocked.length > 0 || blockedFix.length > 0 ? (
      <ul className="mpo-carton-blocked">
        {blocked.map((packet) => (
          <li key={packet.eventId} role="alert">⚠ {packet.cartonNote}</li>
        ))}
        {blockedFix.map((run) => (
          <li key={run.runId} role="alert">⚠ {run.cartonNote}</li>
        ))}
      </ul>
    ) : null}

    {printed.length > 0 ? (
      <>
        <h4 className="mpo-printed-title">{text.cartonPrintedHeading}</h4>
        <ul className="mpo-printed-list">
          {printed.map((run) => (
            <PrintedRow
              key={run.key}
              run={run}
              printing={printingKey === run.key}
              disabled={printingKey !== null}
              onReprint={() => onReprint(run)}
            />
          ))}
        </ul>
      </>
    ) : null}
  </section>
);
