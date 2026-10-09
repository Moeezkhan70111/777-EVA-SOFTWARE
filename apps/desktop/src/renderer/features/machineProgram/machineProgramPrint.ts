import { MACHINE_INJECTORS, formatShiftRange } from "@erp/domain";
import type { MachineProgramRecord, MachineProgramRunRecord } from "../../types/desktopApi";
import { getColorHex } from "../../components/shared/ColorSwatch";
import { loadLogoDataUrl, openPrintDocumentAsync } from "../../platform/print";
import { escapeHtml } from "../../utils/html";
import { formatDate, formatDateTime } from "../../utils/dates";
import { copy } from "../../config/copy";
import { formatAmount, formatNumber, injectorRuns, injectorsInUse, statusLabel } from "./machineProgram";

// The machine program as it goes to the floor: ONE A5 sheet, drawn to the owner's layout
// (2026-10-09).
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │  [logo]        Machine Program          Program #  MP-000008 │
//   │           Generated on 09 Oct 2026 …    Machine    MACHINE 1 │
//   │                                         Contractor ALAMGIR   │
//   ├──────────────────────────────────────────────────────────────┤
//   │ Injector 1                                                   │
//   │  ┌ SK30  7/10 ┐ ┌ SK12  7/10 ┐ ┌ SK46  7/10 ┐                │
//   │  │ ● BLACK·RED 10 │ …        │ │ …          │                │
//   ├──────────────────────────────────────────────────────────────┤
//   │  Total injectors 1          Total DOZEN 70                   │
//   └──────────────────────────────────────────────────────────────┘
//
// Built from the SAVED program, never from what is on screen: the sheet that goes to the
// machine has to be the same document the store scans against.
//
// It is NOT the generic report table any more. A machine minder reads this standing at a
// machine, so it is grouped the way they work — injector, then article and size, then one
// line per colour pair — rather than as eight columns of repeated text. The sheet still opens
// through platform/print, so "PDF" is the print dialog's Save as PDF and no second print path
// exists (R1, R7).
//
// A line reads "BLACK · RED": the SOLE is black and the UPPER going on it is red. Two colours
// in one row is how the floor says it, so the dot is the upper's colour and the words name
// both — colour is never the only cue (R18).

/** One article + size on an injector, and every colour pair being made in it. */
interface ArticleCard {
  article: string;
  size: string;
  rows: Array<{ sole: string; upper: string; quantity: string }>;
}

/**
 * The cards of one injector: its runs grouped by article and size.
 *
 * Several sole colours can be making the same article, so the sole is named on every line
 * rather than on the card — the card is the thing being made, the line is what it is made of.
 */
const articleCards = (runs: MachineProgramRunRecord[]): ArticleCard[] => {
  const byArticleSize = new Map<string, ArticleCard>();
  for (const run of runs) {
    const key = `${run.article}|${run.size}`;
    let card = byArticleSize.get(key);
    if (!card) {
      card = { article: run.article, size: run.size, rows: [] };
      byArticleSize.set(key, card);
    }
    for (const line of run.lines) {
      card.rows.push({ sole: run.soleColour, upper: line.upperColour, quantity: formatNumber(line.quantity) });
    }
  }
  return [...byArticleSize.values()].filter((card) => card.rows.length > 0);
};

const dot = (colour: string): string =>
  `<span class="dot" style="background:${escapeHtml(getColorHex(colour))}"></span>`;

const cardHtml = (card: ArticleCard): string => `
  <section class="card">
    <header class="card-head">
      <span class="card-article">${escapeHtml(card.article)}</span>
      <span class="card-size">${escapeHtml(card.size)}</span>
    </header>
    <div class="card-cols"><span>Sole · Upper</span><span>Qty</span></div>
    ${card.rows
      .map(
        (row) => `<div class="line">
          <span class="line-colour">${dot(row.upper)}${escapeHtml(row.sole)} · <b>${escapeHtml(row.upper)}</b></span>
          <span class="line-qty">${escapeHtml(row.quantity)}</span>
        </div>`
      )
      .join("")}
  </section>`;

const injectorHtml = (program: MachineProgramRecord, injectorNo: number): string => {
  const cards = articleCards(injectorRuns(program, injectorNo));
  if (cards.length === 0) return "";
  return `
    <section class="injector">
      <h2 class="injector-name">${escapeHtml(copy.machineProgram.injector(injectorNo))}</h2>
      <div class="cards">${cards.map(cardHtml).join("")}</div>
    </section>`;
};

/** One row of the box at the top right. */
const fact = (label: string, value: string, tone?: "ok"): string =>
  `<div class="fact"><dt>${escapeHtml(label)}</dt><dd${tone ? ` class="${tone}"` : ""}>${escapeHtml(value)}</dd></div>`;

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

  /* ── Head: the mark, the title, and what this program IS ──
     The left column is kept the same width as the box on the right so the title sits on the
     centre line of the paper, not pushed off it by a wide box. */
  .head { display: flex; align-items: flex-start; gap: 8px; }
  .head-logo { flex: 0 0 60mm; padding-top: 2px; }
  .head-logo img { width: 46px; height: auto; }
  .head-title { flex: 1; text-align: center; padding-top: 2px; }
  .head-title h1 { margin: 0; font-size: 19pt; font-weight: 800; letter-spacing: -.01em; color: #17365d; }
  .head-title p { margin: 2px 0 0; font-size: 8pt; color: #475569; }
  .head-title p b { color: #0f172a; }
  .facts {
    flex: 0 0 60mm; margin: 0; padding: 6px 9px;
    background: #eff4fb; border: 1px solid #c7d7ee; border-radius: 4px;
  }
  .fact { display: flex; gap: 6px; align-items: baseline; }
  .fact + .fact { margin-top: 1.5px; }
  .fact dt { flex: 0 0 16mm; margin: 0; font-size: 7pt; color: #475569; }
  .fact dd { margin: 0; font-size: 8pt; font-weight: 700; color: #0f172a; }
  .fact dd.ok { color: #15803d; }

  /* ── One injector, and the articles running in it ── */
  .injector { margin-top: 8px; border: 1px solid #c7d7ee; border-radius: 5px; overflow: hidden; }
  /* A band never sits alone at the foot of a page; a card is never split down the middle. */
  .injector-name {
    margin: 0; padding: 5px 10px; background: #17365d; color: #fff;
    font-size: 11.5pt; font-weight: 700; letter-spacing: .01em;
    break-after: avoid; page-break-after: avoid;
  }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; padding: 5px; }
  .card { border: 1px solid #d7e2f2; border-radius: 4px; overflow: hidden; break-inside: avoid; page-break-inside: avoid; }
  .card-head { display: flex; align-items: baseline; gap: 6px; padding: 3px 7px; background: #eff4fb; }
  .card-article { font-size: 13pt; font-weight: 800; color: #0f172a; }
  .card-size { font-size: 9.5pt; font-weight: 600; color: #334155; }
  .card-cols {
    display: flex; justify-content: space-between; padding: 2px 7px;
    font-size: 6pt; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: #94a3b8;
    border-bottom: 1px solid #e6edf7;
  }
  .line { display: flex; justify-content: space-between; align-items: center; gap: 6px; padding: 4px 7px; }
  .line + .line { border-top: 1px solid #eef3fa; }
  .line-colour { display: flex; align-items: center; gap: 5px; font-size: 9pt; color: #334155; }
  .line-colour b { color: #0f172a; }
  .dot { width: 9px; height: 9px; border-radius: 50%; border: 1px solid rgba(15,23,42,.18); flex: 0 0 9px; }
  .line-qty { font-size: 11pt; font-weight: 800; font-variant-numeric: tabular-nums; }

  /* ── What the machine comes to ── */
  .totals {
    display: flex; margin-top: 8px; border: 1px solid #c7d7ee; border-radius: 5px; background: #f8fafc;
  }
  .total { flex: 1; padding: 6px 12px; text-align: center; }
  .total + .total { border-left: 1px solid #c7d7ee; }
  .total dt { margin: 0; font-size: 8pt; color: #475569; }
  .total dd { margin: 1px 0 0; font-size: 15pt; font-weight: 800; color: #17365d; font-variant-numeric: tabular-nums; }

  .foot {
    display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
    margin-top: 7px; padding-top: 5px; border-top: 1px solid #c7d7ee; font-size: 7.5pt; color: #64748b;
  }
  .foot .tagline { font-style: italic; }
  .note { margin: 4px 0 0; font-size: 6.5pt; color: #94a3b8; }
  .empty { margin: 16px 0; text-align: center; font-size: 10pt; color: #64748b; }
`;

const buildSheetHtml = (program: MachineProgramRecord, preparedBy: string | null | undefined, logo: string): string => {
  const injectors = MACHINE_INJECTORS.map((injectorNo) => injectorHtml(program, injectorNo)).join("");
  const total = formatAmount(program.totalQuantity, program.unitCode);
  // "Total DOZEN · 70" when every line shares a unit, and a plain total when they differ.
  const totalLabel = program.unitCode ? `Total ${program.unitCode}` : copy.machineProgram.totalProduction;
  const totalValue = program.unitCode ? formatNumber(program.totalQuantity) : total;

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
    <div class="head">
      <div class="head-logo">${logo ? `<img src="${logo}" alt="" />` : ""}</div>
      <div class="head-title">
        <h1>${escapeHtml(copy.machineProgram.title)}</h1>
        <p>Generated on <b>${escapeHtml(formatDateTime(new Date()))}</b></p>
      </div>
      <dl class="facts">
        ${fact(copy.machineProgram.printProgramNo, program.code)}
        ${fact(copy.machineProgram.machineLabel, program.machineName)}
        ${fact(copy.columns.date, formatDate(program.programDate))}
        ${fact(copy.machineProgram.contractor, program.contractorName)}
        ${fact(copy.machineProgram.printPacking, program.packingContractorName ?? copy.machineProgram.noPackingContractorYet)}
        ${fact(copy.machineProgram.shiftTime, formatShiftRange({ startMinute: program.shiftStartMinute, endMinute: program.shiftEndMinute }))}
        ${fact(copy.columns.status, statusLabel(program.displayStatus), "ok")}
      </dl>
    </div>

    ${injectors || `<p class="empty">${escapeHtml(copy.machineProgram.noProgramYet)}</p>`}

    <dl class="totals">
      <div class="total">
        <dt>Total injectors</dt>
        <dd>${escapeHtml(String(injectorsInUse(program)))}</dd>
      </div>
      <div class="total">
        <dt>${escapeHtml(totalLabel)}</dt>
        <dd>${escapeHtml(totalValue)}</dd>
      </div>
    </dl>

    <div class="foot">
      <span>Prepared by <b>${escapeHtml(preparedBy?.trim() || program.createdBy || "—")}</b> · ${escapeHtml(formatDate(program.createdAt))}</span>
      <span class="tagline">Quality Today. Better Tomorrow.</span>
    </div>
    <p class="note">${escapeHtml(copy.machineProgram.reservationNote)}</p>
  </div>
</body>
</html>`;
};

export const printMachineProgram = (program: MachineProgramRecord, preparedBy?: string | null): boolean =>
  openPrintDocumentAsync(loadLogoDataUrl().then((logo) => buildSheetHtml(program, preparedBy, logo)));
