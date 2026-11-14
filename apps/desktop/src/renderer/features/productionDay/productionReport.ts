import { cartonsToDozens, type CartonMatrixArticle, type ProductionDayMachine, type ProductionDayView } from "@erp/domain";
import { copy } from "../../config/copy";
import { escapeHtml } from "../../utils/html";
import { formatDateTime, formatLongDate, formatTime } from "../../utils/dates";

// THE DAILY PRODUCTION PDF (owner, 14 Nov 2026): "proper format with logo and all the necessary details. No clutter.
// Minimal, easy to understand."
//
//   ┌ logo ──────────────────────────────────────────── DAILY PRODUCTION · 14 Nov 2026 ┐
//   │ Status  ✓ Completed at 6:40 PM by admin        Machine  All machines            │
//   │ [ Total 120.5 dozen ] [ Cartons 241 ] [ Machines 3 ] [ Entries 18 ]              │
//   │ MACHINE 1 · 40 dozen                                                              │
//   │   SK12   │ BLACKBLUE │ BLACKRED │ GREEN │ Total                                   │
//   │   7/10   │     1     │    2     │  54   │  57                                     │
//   │   4/6    │     2     │   10     │   -   │  12                                     │
//   │   Total  │     3     │   12     │  54   │  69                                     │
//   │ … every machine, then all machines together (when there is more than one)        │
//   └ All figures are in dozen. · Printed 14 Nov 2026, 6:45 PM ─────────────────────────┘
//
// Every figure is the main process's (productionDayView); this only lays it out, in dozens, as the screen does. Every
// text that came from the data (articles, colours, machines, names) is escaped (R9).

const text = copy.productionReport;

/** Dozens as the screen shows them; a box with nothing is a dash. */
const dozens = (cartons: number): string => {
  if (cartons === 0) return "-";
  return cartonsToDozens(cartons).toLocaleString("en-US");
};

/** Dozens for a total that is really zero: "0", never a dash. */
const dozensTotal = (cartons: number): string => (cartons === 0 ? "0" : dozens(cartons));

const STYLES = `
  * { box-sizing: border-box; }
  @page { size: A4 portrait; margin: 14mm 12mm; }
  body { margin: 0; font-family: "Segoe UI", Helvetica, Arial, sans-serif; color: #111; font-size: 12px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .letterhead { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding-bottom: 10px; border-bottom: 3px solid #17365d; }
  .letterhead img { height: 50px; width: auto; }
  .brand-text { font-size: 22px; font-weight: 900; letter-spacing: .04em; color: #17365d; }
  .brand-text small { display: block; font-size: 10px; font-weight: 700; letter-spacing: .14em; color: #555; }
  .doc-title { text-align: right; }
  .doc-title h1 { margin: 0; font-size: 19px; letter-spacing: .14em; text-transform: uppercase; color: #17365d; }
  .doc-title .day { margin-top: 3px; font-size: 14px; font-weight: 700; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px 28px; margin: 12px 0 10px; font-size: 12px; }
  .facts b { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #555; margin-right: 6px; }
  .figures { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
  .figure { border: 1px solid #c9d3e0; border-radius: 6px; padding: 7px 10px; }
  .figure span { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: .08em; color: #555; }
  .figure strong { font-size: 17px; font-variant-numeric: tabular-nums; }
  .figure.main { border-color: #17365d; background: #eef2f7; }
  h2 { margin: 18px 0 8px; padding-bottom: 4px; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: #17365d; border-bottom: 1px solid #c9d3e0; break-after: avoid; page-break-after: avoid; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; table-layout: fixed; break-inside: avoid; page-break-inside: avoid; }
  th, td { border: 1px solid #9aa5b4; padding: 5px 6px; text-align: center; font-variant-numeric: tabular-nums; }
  thead th { background: #eef2f7; color: #17365d; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; word-break: break-word; }
  thead th.article { width: 18%; text-align: left; font-size: 13px; letter-spacing: .02em; color: #111; }
  thead th.total { width: 13%; }
  tbody th, tfoot th { text-align: left; font-weight: 700; }
  td { font-size: 12px; }
  .total { background: #f5f7fa; font-weight: 800; }
  tfoot th, tfoot td { background: #eef2f7; font-weight: 800; }
  tfoot td.grand { background: #17365d; color: #fff; }
  .empty { margin: 30px 0; text-align: center; color: #555; font-size: 14px; }
  .foot { margin-top: 18px; padding-top: 6px; border-top: 1px solid #c9d3e0; display: flex; justify-content: space-between; font-size: 9.5px; color: #666; }
`;

/** One article: its name over the Size column, its colours across, totals per size, per colour and the article's. */
export function articleTable(article: CartonMatrixArticle): string {
  const colours = article.colours.map((colour) => `<th scope="col">${escapeHtml(colour)}</th>`).join("");
  const rows = article.rows
    .map((row) => {
      const cells = row.quantities.map((quantity) => `<td>${dozens(quantity)}</td>`).join("");
      return `<tr><th scope="row">${escapeHtml(row.size)}</th>${cells}<td class="total">${dozensTotal(row.total)}</td></tr>`;
    })
    .join("");
  const totals = article.colourTotals.map((quantity) => `<td>${dozensTotal(quantity)}</td>`).join("");
  return `<table>
    <thead><tr><th scope="col" class="article">${escapeHtml(article.article)}</th>${colours}<th scope="col" class="total">${escapeHtml(text.total)}</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th scope="row">${escapeHtml(text.total)}</th>${totals}<td class="grand">${dozensTotal(article.total)}</td></tr></tfoot>
  </table>`;
}

const section = (heading: string, articles: readonly CartonMatrixArticle[]): string =>
  `<h2>${escapeHtml(heading)}</h2>${articles.map(articleTable).join("")}`;

const machineSection = (machine: ProductionDayMachine): string =>
  section(text.machineHeading(machine.machineName, dozensTotal(machine.cartons)), machine.articles);

export interface ProductionReportInput {
  day: ProductionDayView;
  /** One machine's report; null for the whole day. */
  machineName: string | null;
  /** The letterhead logo as a data URL; empty prints the brand as text. */
  logoDataUrl: string;
  /** When the report is made, for its foot. */
  printedAt: Date;
}

/** The figures the report is about: the whole day, or one machine of it. Null when that machine has nothing. */
const scopeOf = (day: ProductionDayView, machineName: string | null) => {
  if (machineName === null) return { cartons: day.totalCartons, entries: day.entries, machines: day.machines };
  const machine = day.machines.find((item) => item.machineName === machineName);
  return machine ? { cartons: machine.cartons, entries: machine.entries, machines: [machine] } : null;
};

const statusText = (day: ProductionDayView): string =>
  day.completed ? `✓ ${text.completed(formatTime(day.completed.completedAt), day.completed.completedBy)}` : text.notCompleted;

const letterhead = (input: ProductionReportInput): string => {
  const brand = input.logoDataUrl
    ? `<img src="${escapeHtml(input.logoDataUrl)}" alt="${escapeHtml(text.logoAlt)}" />`
    : `<div class="brand-text">${escapeHtml(text.brand)}<small>${escapeHtml(text.brandSub)}</small></div>`;
  return `<div class="letterhead">${brand}<div class="doc-title"><h1>${escapeHtml(text.title)}</h1><div class="day">${escapeHtml(formatLongDate(input.day.date))}</div></div></div>`;
};

const figure = (label: string, value: string, main = false): string =>
  `<div class="figure${main ? " main" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;

/** The whole report, as a standalone HTML page for the main process to save as a PDF. */
export function productionReportHtml(input: ProductionReportInput): string {
  const scope = scopeOf(input.day, input.machineName);
  const facts = `<div class="facts">
    <div><b>${escapeHtml(text.status)}</b>${escapeHtml(statusText(input.day))}</div>
    <div><b>${escapeHtml(text.machine)}</b>${escapeHtml(input.machineName ?? text.allMachines)}</div>
  </div>`;
  let body: string;
  if (!scope || scope.cartons === 0) {
    body = `<p class="empty">${escapeHtml(text.empty)}</p>`;
  } else {
    const figures = `<div class="figures">
      ${figure(text.totalDozens, dozensTotal(scope.cartons), true)}
      ${figure(text.cartons, scope.cartons.toLocaleString("en-US"))}
      ${figure(text.machines, scope.machines.length.toLocaleString("en-US"))}
      ${figure(text.entries, scope.entries.toLocaleString("en-US"))}
    </div>`;
    const together = input.machineName === null && input.day.machines.length > 1 ? section(text.allMachinesHeading(dozensTotal(input.day.totalCartons)), input.day.articles) : "";
    body = figures + scope.machines.map(machineSection).join("") + together;
  }
  const foot = `<div class="foot"><span>${escapeHtml(text.unit)}</span><span>${escapeHtml(text.printed(formatDateTime(input.printedAt)))}</span></div>`;
  return `<!doctype html><html><head><meta charset="utf-8" /><title>${escapeHtml(text.fileName(input.day.date, input.machineName))}</title><style>${STYLES}</style></head><body>${letterhead(input)}${facts}${body}${foot}</body></html>`;
}

/** The name offered in the Save dialog. */
export const productionReportFileName = (date: string, machineName: string | null): string => `${text.fileName(date, machineName)}.pdf`;
