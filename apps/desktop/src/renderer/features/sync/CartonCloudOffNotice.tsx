import React, { useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { copy } from "../../config/copy";

// Shown on the screens where carton and money work is entered (Manual Production, carton adjustments, gatepasses,
// bills, cash vouchers) while Carton Cloud is not active on this computer: anything saved here then is test data and
// never reaches the cloud, even after activation (packages/data/src/database/stockProtection.ts). Nothing is shown on a
// computer that does not sync, or once Carton Cloud is active. If the state cannot be read, it warns: a missing warning
// is the costly mistake here, not an extra one.

type Shown = "NONE" | "OFF" | "INVALID" | "UNKNOWN";

const MESSAGE: Readonly<Record<Exclude<Shown, "NONE">, string>> = {
  OFF: copy.cartonCloud.offNotice,
  INVALID: copy.cartonCloud.offNoticeInvalid,
  UNKNOWN: copy.cartonCloud.offNoticeUnknown,
};

export const CartonCloudOffNotice: React.FC = () => {
  const api = useDesktopApi();
  const [shown, setShown] = useState<Shown>("NONE");

  useEffect(() => {
    let live = true;
    const read = async (): Promise<Shown> => {
      try {
        const reply = await api.getCartonCloudState();
        if (!reply.accepted) return "UNKNOWN";
        if (!reply.value.configured || reply.value.state === "ACTIVE") return "NONE";
        return reply.value.state === "INVALID" ? "INVALID" : "OFF";
      } catch {
        return "UNKNOWN";
      }
    };
    void read().then((next) => {
      if (live) setShown(next);
    });
    return () => {
      live = false;
    };
  }, [api]);

  if (shown === "NONE") return null;
  return (
    <div className="sync-notice is-warning" role="status" aria-label={copy.cartonCloud.offNoticeTitle}>
      <span className="sync-notice-icon" aria-hidden="true">⚠</span>
      <div className="sync-notice-body">
        <p className="sync-notice-title">{copy.cartonCloud.offNoticeTitle}</p>
        <p>{MESSAGE[shown]}</p>
      </div>
    </div>
  );
};
