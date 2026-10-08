import React, { useEffect, useMemo, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { ProductionScannerPanel, type ScanState } from "../components/production/ProductionScannerPanel";
import { useNotifications } from "../state/NotificationsContext";
import { playScanSound } from "../utils/playScanSound";

const parseQrDisplay = (raw: string) => {
  const [article = "", color = "", size = ""] = raw.split("_");
  return { article, color, size };
};

export const ProductionPage = () => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [scanInput, setScanInput] = useState("");
  const [count, setCount] = useState(0);
  const [scanState, setScanState] = useState<ScanState>({
    status: "idle",
    message: "Scan a QR code or enter a value manually, then press Enter or Process.",
  });

  const loadCount = async () => {
    const snap = await api.getDashboard();
    setCount(snap.todaysProduction);
  };

  useEffect(() => { void loadCount(); }, []);

  const onSubmit = async () => {
    const raw = scanInput.trim().toUpperCase();
    if (!raw) return;

    const result = await api.processScan(raw);
    const d = parseQrDisplay(raw);

    if (result.accepted) {
      playScanSound("success");
      await loadCount();
      const nextCount = count + 1;
      setScanState({
        status: "success",
        message: "Scan accepted and recorded to production pipeline.",
        qrId: result.qrId,
        article: d.article,
        color: d.color,
        size: d.size,
        ts: new Date().toISOString(),
        productionCount: nextCount,
      });
      setScanInput("");
      push("success", "Production Recorded", result.qrId);
      return;
    }

    playScanSound("error");
    setScanState({
      status: "error",
      message: result.reason ?? "Scan rejected.",
      qrId: raw,
      article: d.article,
      color: d.color,
      size: d.size,
      ts: new Date().toISOString(),
      productionCount: count,
    });
    push("error", "Scan Rejected", result.reason ?? "Invalid or duplicate scan.");
  };

  const panelState = useMemo(
    () => ({ ...scanState, productionCount: scanState.productionCount ?? count }),
    [scanState, count]
  );

  return (
    <ProductionScannerPanel
      scanState={panelState}
      scanInput={scanInput}
      onChange={setScanInput}
      onSubmit={() => void onSubmit()}
    />
  );
};
