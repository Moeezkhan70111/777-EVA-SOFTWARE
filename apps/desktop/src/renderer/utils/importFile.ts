// Reading a spreadsheet the operator saved out of Excel.
//
// Parsing is kept apart from `exportFile.ts` because the risks are opposite ways round:
// writing a file can assume its own data is sound, reading one must assume nothing. Anything
// this returns is untrusted text that the data layer validates again before it becomes a row
// (CLAUDE.md R25).
//
// The parser itself lives in @erp/domain (delimitedText.ts), shared with the data layer's tests;
// this adds reading the chosen File.

import { ImportFileError, parseDelimitedText, type ParsedSheet } from "@erp/domain";

export { ImportFileError, parseDelimitedText, type ParsedSheet };

const MAX_BYTES = 5 * 1024 * 1024;

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
