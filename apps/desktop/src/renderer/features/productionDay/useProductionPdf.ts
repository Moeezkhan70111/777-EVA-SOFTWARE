import { useCallback, useState } from "react";
import type { ProductionDayView } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { loadLogoDataUrl } from "../../platform/print";
import { useOptionalNotifications } from "../../state/NotificationsContext";
import { productionReportFileName, productionReportHtml } from "./productionReport";

// "Download PDF" for a day's production, or one machine of it (productionReport.ts). The main process asks where to
// save it and writes the file (savePdfDocument); this builds the page and says how it went.

const text = copy.productionReport;

export type SavePdfReply = { kind: "saved"; filePath: string } | { kind: "canceled" } | { kind: "failed"; reason: string | null };

/** The main process's answer, checked (R25). Anything that does not read as one is a failure. */
export function parseSavePdfReply(reply: unknown): SavePdfReply {
  const record = typeof reply === "object" && reply !== null ? (reply as Record<string, unknown>) : {};
  if (record.accepted === true && typeof record.filePath === "string") return { kind: "saved", filePath: record.filePath };
  if (record.canceled === true) return { kind: "canceled" };
  return { kind: "failed", reason: typeof record.reason === "string" && record.reason ? record.reason : null };
}

/** The download, and which one is being made right now: a machine's name, or "" for the whole day. */
export const useProductionPdf = () => {
  const api = useDesktopApi();
  const notices = useOptionalNotifications();
  const [making, setMaking] = useState<string | null>(null);

  const download = useCallback(
    async (day: ProductionDayView, machineName: string | null) => {
      setMaking(machineName ?? "");
      try {
        const html = productionReportHtml({ day, machineName, logoDataUrl: await loadLogoDataUrl(), printedAt: new Date() });
        const reply = parseSavePdfReply(await api.savePdfDocument({ html, fileName: productionReportFileName(day.date, machineName) }));
        if (reply.kind === "saved") notices?.push("success", text.savedTitle, text.savedBody(reply.filePath));
        if (reply.kind === "failed") notices?.push("error", text.failedTitle, reply.reason ?? text.failedBody);
      } catch (error) {
        notices?.push("error", text.failedTitle, error instanceof Error && error.message ? error.message : text.failedBody);
      } finally {
        setMaking(null);
      }
    },
    [api, notices]
  );

  return { download, making };
};

export type ProductionPdf = ReturnType<typeof useProductionPdf>;
