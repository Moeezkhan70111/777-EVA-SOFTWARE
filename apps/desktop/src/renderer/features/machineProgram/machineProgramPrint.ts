import { MACHINE_INJECTORS, formatShiftRange, isFixRun } from "@erp/domain";
import type { MachineProgramRecord, MachineProgramRunRecord } from "../../types/desktopApi";
import { renderQrSvgMarkup } from "../../utils/qrLabels";
import { loadLogoDataUrl, openPrintDocumentAsync } from "../../platform/print";
import { escapeHtml } from "../../utils/html";
import { formatDate } from "../../utils/dates";
import { copy } from "../../config/copy";
import {
  colourRuns,
  formatAmount,
  formatNumber,
  injectorRuns,
  injectorsInUse,
  runColours,
  statusLabel,
  statusTone,
} from "./machineProgram";

// The machine program as it goes to the floor: ONE A5 sheet, drawn to the owner's layout
// (2026-10-11).
//
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │                             [ 777 logo ]                             │
//   │                          Machine Program                             │
//   │  Program# │ Machine │ Date │ Contractor │ Packing │ Shift │ Status    │
//   ├──────────────────────────────────────────────────────────────────────┤
//   │ Injector 1 │ Sole Color : BLACK                                       │
//   │  ┌ SK30 7/10 ─┐ ┌ SK12 7/10 ─┐ ┌ SK46 7/10 ─┐                        │
//   │  │ BLACK RED 10│ │ BLACK RED 10│ │ BLACK RED 10│                      │
//   ├──────────────────────────────────────────────────────────────────────┤
//   │  🏭 Total Injectors 1        📦 Total Dozen 70 DOZEN                  │
//   ├──────────────────────────────────────────────────────────────────────┤
//   │  Prepared by …                              [QR] MP-000008            │
//   └──────────────────────────────────────────────────────────────────────┘
//
// Built from the SAVED program, never from what is on screen: the sheet that goes to the
// machine has to be the same document the store scans against. It opens through
// platform/print, so "PDF" is the print dialog's Save as PDF and no second print path exists.
//
// WHERE EACH THING SITS, and why — the sheet is read in three passes:
//
//   1. WHAT IS THIS?      the mark, the title, and the meta strip. Seven facts that identify
//                         the document, laid across one line rather than stacked in a corner
//                         box: a machine minder checks "is this my machine, my shift?" at a
//                         glance, and a strip reads left-to-right in one sweep.
//   2. WHAT DO I MAKE?    a band per INJECTOR + SOLE COLOUR, then a card per article + size.
//                         The sole colour moved OUT of every line and onto the band, because
//                         it is a property of the run, not of the upper — it was being
//                         repeated on every row of every card. Grouping this way also makes
//                         the sheet agree with the workspace screen, which groups by sole.
//   3. WHAT DOES IT COME TO?  the totals, then who prepared it.
//
// CONTRACTOR PRICING IS NOT ON THE SHEET (owner, 2026-10-11). The sheet goes to the floor and
// into the contractor's hand; what the work is paid at stays on the Program Summary screen.
//
// THE QR lives in the FOOTER, not the header. It is not a fact about the program — the number
// beside it is already in the meta strip. It is an ACTION on the document: the storekeeper
// scans it to open this program on Store Out. So it belongs with the document's own
// provenance (who prepared it, when), away from the production figures a minder reads.
//
// A line reads "BLACK RED": the SOLE is black and the UPPER going on it is red. That is how
// the floor says it out loud, and both colours are named in words, so nothing here depends on
// a reader telling two printed colours apart (R18).

/** One article + size under a sole colour, and every upper being made in it. */
interface ArticleCard {
  article: string;
  size: string;
  rows: Array<{ sole: string; upper: string; quantity: string }>;
}

/** The cards of one sole colour: its runs grouped by article and size. */
const articleCards = (runs: MachineProgramRunRecord[]): ArticleCard[] => {
  const byArticleSize = new Map<string, ArticleCard>();
  for (const run of runs) {
    const key = `${run.article}|${run.size}`;
    let card = byArticleSize.get(key);
    if (!card) {
      card = { article: run.article, size: run.size, rows: [] };
      byArticleSize.set(key, card);
    }
    // A FIX run has no uppers at all: it is moulded from two soles, and the row names the
    // inner one where an upper colour would be (migration 067).
    if (isFixRun(run)) {
      card.rows.push({ sole: run.soleColour, upper: run.innerSoleColour ?? "", quantity: formatNumber(run.fixQuantity) });
      continue;
    }
    for (const line of run.lines) {
      card.rows.push({ sole: run.soleColour, upper: line.upperColour, quantity: formatNumber(line.quantity) });
    }
  }
  return [...byArticleSize.values()].filter((card) => card.rows.length > 0);
};

const cardHtml = (card: ArticleCard): string => `
  <section class="card">
    <header class="card-head">
      <span class="card-article">${escapeHtml(card.article)}</span>
      <span class="card-size">${escapeHtml(card.size)}</span>
    </header>
    <div class="card-body">
      ${card.rows
        .map(
          (row) => `<div class="line">
            <span class="line-colour">${escapeHtml(row.sole)} ${escapeHtml(row.upper)}</span>
            <span class="line-qty">${escapeHtml(row.quantity)}</span>
          </div>`
        )
        .join("")}
    </div>
  </section>`;

/**
 * One band and its cards: an injector making one sole colour.
 *
 * An injector can be given more than one sole colour, so it gets a band per colour rather than
 * one band with a colour it cannot honestly name.
 */
const soleBlockHtml = (injectorNo: number, colour: string, runs: MachineProgramRunRecord[]): string => {
  const cards = articleCards(runs);
  if (cards.length === 0) return "";
  return `
    <section class="injector">
      <h2 class="injector-name">
        <span class="injector-no">${escapeHtml(copy.machineProgram.injector(injectorNo))}</span>
        <span class="injector-sole">${escapeHtml(copy.machineProgram.printSoleColour)} : <b>${escapeHtml(colour)}</b></span>
      </h2>
      <div class="cards">${cards.map(cardHtml).join("")}</div>
    </section>`;
};

const injectorHtml = (program: MachineProgramRecord, injectorNo: number): string => {
  const runs = injectorRuns(program, injectorNo);
  return runColours(runs)
    .map((colour) => soleBlockHtml(injectorNo, colour, colourRuns(runs, colour)))
    .join("");
};

/** One cell of the strip under the title: a quiet label with the fact under it. */
const metaCell = (label: string, value: string, modifier?: string): string =>
  `<div class="meta-cell${modifier ? ` meta-cell--${modifier}` : ""}">
     <dt>${escapeHtml(label)}</dt>
     <dd>${escapeHtml(value)}</dd>
   </div>`;

/** The status cell: a dot AND the word, so the state never depends on the colour alone (R18). */
const statusCell = (program: MachineProgramRecord): string =>
  `<div class="meta-cell meta-cell--status">
     <dt>${escapeHtml(copy.columns.status)}</dt>
     <dd class="tone-${statusTone(program.displayStatus)}"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(
       statusLabel(program.displayStatus)
     )}</dd>
   </div>`;

/** Decorative marks beside the two totals. The label beside each one is what is read (R18). */
const FACTORY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h4v6.2l5-2.8v2.8l5-2.8v2.8l5-2.8V21H3V3zm3 12v3h3v-3H6zm5 0v3h3v-3h-3z"/></svg>`;
const BOX_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 3 7v10l9 5 9-5V7l-9-5zm0 2.3 6.4 3.6L12 11.5 5.6 7.9 12 4.3zM5 9.6l6 3.4v6.7l-6-3.3V9.6zm8 10.1V13l6-3.4v6.8l-6 3.3z"/></svg>`;

const totalCell = (icon: string, label: string, value: string): string =>
  `<div class="total">
     <span class="total-icon">${icon}</span>
     <div class="total-words">
       <dt>${escapeHtml(label)}</dt>
       <dd>${escapeHtml(value)}</dd>
     </div>
   </div>`;

const STYLES = `
  * { box-sizing: border-box; }
  @page { size: A5 landscape; margin: 7mm; }
  body {
    font-family: "Segoe UI", Helvetica, Arial, sans-serif;
    margin: 0; padding: 10px; color: #0f172a; font-size: 9pt; line-height: 1.3;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .print-actions { text-align: center; margin-bottom: 10px; }
  .print-actions button {
    padding: 8px 24px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
    background: #17365d; color: #fff; border: none; border-radius: 4px; cursor: pointer;
  }
  @media print { .print-actions { display: none; } body { padding: 0; } }

  .sheet { max-width: 196mm; margin: 0 auto; }

  /* ── 1. What is this? ──────────────────────────────────────────────────
     The mark is centred on the paper, the title under it, and the seven facts
     that identify the program across one strip. */
  .mark { text-align: center; padding-bottom: 4px; border-bottom: 1px solid #c7d7ee; }
  .mark img { height: 13mm; width: auto; }
  .title { margin: 6px 0 7px; text-align: center; font-size: 22pt; font-weight: 800; letter-spacing: -.015em; color: #17365d; }

  .meta {
    display: flex; margin: 0; border: 1px solid #c7d7ee; border-radius: 5px; background: #f6f9fd; overflow: hidden;
  }
  .meta-cell { flex: 1 1 0; min-width: 0; padding: 5px 9px; }
  .meta-cell + .meta-cell { border-left: 1px solid #c7d7ee; }
  /* The shift is the longest fact on the strip and must never wrap onto a second line. */
  .meta-cell--shift { flex: 1.65 1 0; }
  .meta-cell--status { flex: 1.3 1 0; }
  .meta-cell dt { margin: 0; font-size: 7pt; font-weight: 500; color: #64748b; }
  .meta-cell dd {
    margin: 1px 0 0; font-size: 9.5pt; font-weight: 700; color: #0f172a;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .meta-cell dd.tone-ok { color: #15803d; }
  .meta-cell dd.tone-warn { color: #b45309; }
  .meta-cell dd.tone-muted { color: #64748b; }
  .status-dot {
    display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%;
    background: currentColor; vertical-align: middle;
  }

  /* ── 2. What do I make? ────────────────────────────────────────────────
     One band per injector + sole colour, then a card per article and size. */
  .injector { margin-top: 8px; border: 1px solid #c7d7ee; border-radius: 5px; overflow: hidden; }
  /* A band never sits alone at the foot of a page; a card is never split down the middle. */
  .injector-name {
    display: flex; align-items: baseline; gap: 11px;
    margin: 0; padding: 6px 11px; background: #17365d; color: #fff;
    break-after: avoid; page-break-after: avoid;
  }
  .injector-no { font-size: 12.5pt; font-weight: 800; }
  .injector-sole {
    padding-left: 11px; border-left: 1px solid rgba(255,255,255,.35);
    font-size: 10pt; font-weight: 500; color: #dbe7f7;
  }
  .injector-sole b { font-weight: 800; color: #fff; letter-spacing: .02em; }

  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 6px; }
  .card { border: 1px solid #d7e2f2; border-radius: 4px; overflow: hidden; break-inside: avoid; page-break-inside: avoid; }
  .card-head { display: flex; align-items: baseline; gap: 7px; padding: 4px 9px; background: #eff4fb; border-bottom: 1px solid #d7e2f2; }
  .card-article { font-size: 14pt; font-weight: 800; color: #0f172a; letter-spacing: -.01em; }
  .card-size { font-size: 10.5pt; font-weight: 600; color: #475569; }
  .card-body { padding: 0 9px; }
  .line { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 5px 0; }
  .line + .line { border-top: 1px solid #eef3fa; }
  .line-colour { font-size: 9.5pt; font-weight: 700; color: #1e293b; letter-spacing: .01em; }
  .line-qty { font-size: 12pt; font-weight: 800; font-variant-numeric: tabular-nums; color: #0f172a; }

  /* ── 3. What does it come to? ──────────────────────────────────────── */
  .totals { display: flex; margin: 8px 0 0; border: 1px solid #c7d7ee; border-radius: 5px; background: #f6f9fd; }
  .total { flex: 1; display: flex; align-items: center; justify-content: center; gap: 11px; padding: 7px 12px; }
  .total + .total { border-left: 1px solid #c7d7ee; }
  .total-icon svg { width: 10mm; height: 10mm; fill: #17365d; display: block; }
  .total-words dt { margin: 0; font-size: 9pt; color: #475569; }
  .total-words dd { margin: 0; font-size: 16pt; font-weight: 800; color: #17365d; font-variant-numeric: tabular-nums; line-height: 1.15; }

  /* ── Who prepared it, and how to act on it ──────────────────────────────
     The QR sits here rather than in the head: it is what the STORE does with the
     sheet, not one of the facts the floor reads off it. */
  .foot {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    margin-top: 8px; padding-top: 6px; border-top: 1px solid #c7d7ee;
  }
  .foot-by { font-size: 8pt; color: #475569; }
  .foot-by b { color: #0f172a; }
  .foot-note { margin: 2px 0 0; font-size: 6.5pt; color: #94a3b8; max-width: 120mm; }
  .foot-scan { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  .foot-scan svg { width: 16mm; height: 16mm; shape-rendering: crispEdges; display: block; }
  .foot-scan-words { text-align: right; font-size: 7pt; color: #64748b; line-height: 1.35; }
  .foot-scan-words b { display: block; font-size: 9.5pt; color: #0f172a; letter-spacing: .04em; }

  .empty { margin: 16px 0; text-align: center; font-size: 10pt; color: #64748b; }
`;

const buildSheetHtml = (program: MachineProgramRecord, preparedBy: string | null | undefined, logo: string): string => {
  const injectors = MACHINE_INJECTORS.map((injectorNo) => injectorHtml(program, injectorNo)).join("");
  // "Total DOZEN · 70" when every line shares a unit, and a plain total when they differ.
  const totalLabel = program.unitCode ? copy.machineProgram.printTotalIn(program.unitCode) : copy.machineProgram.totalProduction;
  // Everything the machine makes — uppers plus fix — not only what is reserved.
  const totalValue = program.unitCode
    ? `${formatNumber(program.productionQuantity)} ${program.unitCode}`
    : formatAmount(program.productionQuantity, program.unitCode);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(`${copy.machineProgram.title} ${program.code}`)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="print-actions"><button onclick="window.print()">${escapeHtml(copy.reports.printOrSave)}</button></div>
  <div class="sheet">
    <div class="mark">${logo ? `<img src="${logo}" alt="777" />` : ""}</div>
    <h1 class="title">${escapeHtml(copy.machineProgram.title)}</h1>

    <dl class="meta">
      ${metaCell(copy.machineProgram.printProgramNo, program.code)}
      ${metaCell(copy.machineProgram.machineLabel, program.machineName)}
      ${metaCell(copy.columns.date, formatDate(program.programDate))}
      ${metaCell(copy.machineProgram.contractor, program.contractorName)}
      ${metaCell(copy.machineProgram.printPacking, program.packingContractorName ?? copy.machineProgram.noPackingContractorYet)}
      ${metaCell(
        copy.machineProgram.shiftTime,
        formatShiftRange({ startMinute: program.shiftStartMinute, endMinute: program.shiftEndMinute }),
        "shift"
      )}
      ${statusCell(program)}
    </dl>

    ${injectors || `<p class="empty">${escapeHtml(copy.machineProgram.noProgramYet)}</p>`}

    <dl class="totals">
      ${totalCell(FACTORY_ICON, copy.machineProgram.printTotalInjectors, String(injectorsInUse(program)))}
      ${totalCell(BOX_ICON, totalLabel, totalValue)}
    </dl>

    <div class="foot">
      <div>
        <div class="foot-by">${escapeHtml(copy.machineProgram.printPreparedBy)} <b>${escapeHtml(
          preparedBy?.trim() || program.createdBy || "—"
        )}</b> · ${escapeHtml(formatDate(program.createdAt))}</div>
        <p class="foot-note">${escapeHtml(copy.machineProgram.reservationNote)}</p>
      </div>
      <div class="foot-scan">
        ${renderQrSvgMarkup(program.code)}
        <span class="foot-scan-words"><b>${escapeHtml(program.code)}</b>${escapeHtml(copy.machineProgram.printScanHint)}</span>
      </div>
    </div>
  </div>
</body>
</html>`;
};

export const printMachineProgram = (program: MachineProgramRecord, preparedBy?: string | null): boolean =>
  openPrintDocumentAsync(loadLogoDataUrl().then((logo) => buildSheetHtml(program, preparedBy, logo)));
