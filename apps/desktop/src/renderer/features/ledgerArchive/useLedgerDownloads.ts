import { useCallback, useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { loadLogoDataUrl } from "../../platform/print";
import { useOptionalNotifications } from "../../state/NotificationsContext";
import { downloadCsv } from "../../utils/exportFile";
import { parseSavePdfReply } from "../productionDay/useProductionPdf";
import { ledgerReportFileName, ledgerReportHtml, ledgerSheet, type LedgerReportInput } from "./ledgerReport";

// "Download PDF" and "Download Excel" for the Customer and Supplier Ledgers (docs/50, 53): the rows the screen shows for the chosen
// customer, dates and search, live and archived together. The PDF goes through the one PDF writer (savePdfDocument),
// with page numbers; the spreadsheet through the one CSV writer.

const text = copy.ledgerArchive;

export type LedgerDownloadInput = Omit<LedgerReportInput, "logoDataUrl" | "printedAt">;

export function useLedgerDownloads() {
  const api = useDesktopApi();
  const notices = useOptionalNotifications();
  const [making, setMaking] = useState(false);

  const downloadPdf = useCallback(
    async (input: LedgerDownloadInput) => {
      setMaking(true);
      try {
        const html = ledgerReportHtml({ ...input, logoDataUrl: await loadLogoDataUrl(), printedAt: new Date() });
        const fileName = `${ledgerReportFileName(input.customerName, input.fromDate, input.toDate, input.side)}.pdf`;
        const reply = parseSavePdfReply(await api.savePdfDocument({ html, fileName, landscape: true, pageNumbers: true }));
        if (reply.kind === "saved") notices?.push("success", text.pdfSavedTitle, text.pdfSavedBody(reply.filePath));
        if (reply.kind === "failed") notices?.push("error", text.pdfFailedTitle, reply.reason ?? text.pdfFailedBody);
      } catch (error) {
        notices?.push("error", text.pdfFailedTitle, error instanceof Error && error.message ? error.message : text.pdfFailedBody);
      } finally {
        setMaking(false);
      }
    },
    [api, notices]
  );

  const downloadExcel = useCallback((input: LedgerDownloadInput) => {
    downloadCsv(ledgerReportFileName(input.customerName, input.fromDate, input.toDate, input.side), ledgerSheet({ ...input, printedAt: new Date() }));
  }, []);

  return { downloadPdf, downloadExcel, making };
}
