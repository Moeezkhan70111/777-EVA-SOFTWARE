import { useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";

/**
 * Whether a hardware scanner is plugged in, asked every few seconds — the station's "Scanner
 * ready / Keyboard input" pill. False until the first answer, and whenever the question fails.
 */
export const useScannerConnected = (intervalMs = 5000): boolean => {
  const api = useDesktopApi();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (typeof api.getScannerStatus !== "function") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const answer = await api.getScannerStatus();
        if (!cancelled) setConnected(Boolean(answer));
      } catch {
        if (!cancelled) setConnected(false);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, intervalMs]);

  return connected;
};
