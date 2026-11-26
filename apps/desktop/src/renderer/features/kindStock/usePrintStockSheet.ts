import { useCallback, useState } from "react";
import type { StockKind } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { loadLogoDataUrl, openPrintDocumentAsync, urduFontFaceCss } from "../../platform/print";
import { currentColorDictionary } from "../colorTranslation/colorDictionaryStore";
import { buildStockSheet, parseStockSheetReply } from "./stockSheet";
import { buildStockSheetFailureHtml, buildStockSheetHtml } from "./stockSheetPrint";

// Prints one kind's stock sheet. The window opens inside the click (so it is never taken for a pop-up)
// and is filled once the whole store has been read: the sheet always shows the balances as they are
// at the moment of printing, not the page that happens to be on screen.

export const usePrintStockSheet = (kind: StockKind) => {
  const api = useDesktopApi();
  const [blocked, setBlocked] = useState(false);

  const readSheetHtml = useCallback(async (): Promise<string> => {
    try {
      const [reply, logo] = await Promise.all([api.listKindStockSheet(kind), loadLogoDataUrl()]);
      const parsed = parseStockSheetReply(reply);
      if (!parsed.ok) return buildStockSheetFailureHtml(parsed.reason);
      return buildStockSheetHtml(buildStockSheet(parsed.rows, kind), currentColorDictionary(), logo, new Date(), urduFontFaceCss());
    } catch (failure) {
      return buildStockSheetFailureHtml(failure instanceof Error ? failure.message : copy.kindStock.unreadable);
    }
  }, [api, kind]);

  const print = useCallback(() => setBlocked(!openPrintDocumentAsync(readSheetHtml())), [readSheetHtml]);

  return { print, blockedMessage: blocked ? copy.kindStock.printBlocked : null };
};
