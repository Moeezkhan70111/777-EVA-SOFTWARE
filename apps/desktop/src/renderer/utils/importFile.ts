// Reading a spreadsheet the operator saved out of Excel.
//
// Parsing is kept apart from `exportFile.ts` because the risks are opposite ways round:
// writing a file can assume its own data is sound, reading one must assume nothing. Anything
// this returns is untrusted text that the data layer validates again before it becomes a row
// (CLAUDE.md R25).
//
// Excel's "CSV UTF-8" is the format this expects, which is also what our own exports produce
// — so a materials export can be edited and imported back without a conversion step. Tabs
// are accepted too, because "Save as: Text (Tab delimited)" is the other thing Excel offers.

export interface ParsedSheet {
  headers: string[];
  /** One object per row: `heading → cell text`. Blank rows are dropped. */
  rows: Array<Record<string, string>>;
}

export class ImportFileError extends Error {}

const MAX_BYTES = 5 * 1024 * 1024;

/** Splits one delimited line, honouring "quoted, fields" and "" escapes. */
const splitLine = (line: string, delimiter: string): string[] => {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
};

/**
 * Joins lines that were split inside a quoted cell — a remark containing a newline is one
 * cell, not two rows.
 */
const logicalLines = (text: string): string[] => {
  const lines: string[] = [];
  let current = "";
  let quotes = 0;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    current = current === "" ? raw : `${current}\n${raw}`;
    quotes += (raw.match(/"/g) ?? []).length;
    if (quotes % 2 === 0) {
      lines.push(current);
      current = "";
      quotes = 0;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
};

export const parseDelimitedText = (text: string): ParsedSheet => {
  const withoutBom = text.replace(/^﻿/, "");
  const lines = logicalLines(withoutBom).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new ImportFileError("That file is empty.");

  // Our own exports put a title and the filters above the headings, each on a line of its
  // own single cell. So the heading row is the first one as WIDE as the file gets — which
  // also lands on line one for an ordinary file, including a single-column one.
  const delimiter = (lines[0].match(/\t/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? "\t" : ",";
  const widths = lines.slice(0, 10).map((line) => splitLine(line, delimiter).filter(Boolean).length);
  const widest = Math.max(...widths);
  if (widest === 0) throw new ImportFileError("That file has no column headings.");
  const headerIndex = widths.findIndex((width) => width === widest);

  const headers = splitLine(lines[headerIndex], delimiter);
  if (headers.filter(Boolean).length === 0) throw new ImportFileError("That file has no column headings.");

  const rows: Array<Record<string, string>> = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = splitLine(line, delimiter);
    if (cells.every((cell) => cell === "")) continue;
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) row[header] = cells[index] ?? "";
    });
    rows.push(row);
  }

  if (rows.length === 0) throw new ImportFileError("That file has headings but no rows underneath them.");
  return { headers: headers.filter(Boolean), rows };
};

/** Reads a chosen file as text. Rejects anything too large to be a sensible master-data file. */
export const readSheetFile = async (file: File): Promise<ParsedSheet> => {
  if (file.size > MAX_BYTES) {
    throw new ImportFileError("That file is larger than 5 MB. Master data files are much smaller than that — check the file.");
  }
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    throw new ImportFileError(
      'This reads CSV. In Excel choose File → Save As → "CSV UTF-8 (Comma delimited)", then upload that file.'
    );
  }
  const text = await file.text();
  return parseDelimitedText(text);
};
