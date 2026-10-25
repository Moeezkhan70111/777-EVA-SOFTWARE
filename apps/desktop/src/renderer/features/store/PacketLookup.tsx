import React, { useCallback, useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { QrJourney } from "../../types/desktopApi";
import { formatDateTime } from "../../utils/dates";
import { qrStageMeta } from "../../utils/qrLifecycle";
import { ScanPanel, type ScanStationFeedback } from "../scanStation/scanStation";
import { useScanBox } from "../scanStation/useScanBox";

// The scan station a READER gets instead of Store In or Store Out (docs/37 section W): the store is
// written on another computer, so a scan here looks the packet up and changes nothing. It reads the
// same journey the QR Journey page reads (getQrJourney), so a packet is described one way everywhere.

const IDLE: ScanStationFeedback = {
  tone: "idle",
  title: copy.writeLease.lookupTitle,
  message: copy.writeLease.lookupHint,
  result: null,
  seq: 0,
};

/** What one lookup shows. Exported for its test. */
export const lookupFeedback = (code: string, journey: QrJourney | null, seq: number): ScanStationFeedback => {
  if (journey === null) {
    return { tone: "warn", title: copy.writeLease.lookupTitle, message: copy.writeLease.lookupNotFound(code), result: null, seq };
  }
  const where = journey.stageLabel ?? qrStageMeta(journey.currentStatus ?? journey.stage).label;
  return {
    tone: "success",
    title: where,
    message: copy.writeLease.lookupHint,
    result: {
      qrId: journey.qrId,
      product: journey.article,
      currentStatusLabel: where,
      facts: [
        { label: copy.writeLease.lookupSupplier, value: journey.supplierName ?? null },
        { label: copy.writeLease.lookupWhere, value: where },
        { label: copy.writeLease.lookupLastMove, value: formatDateTime(journey.lastActivityAt) },
      ],
    },
    seq,
  };
};

export const PacketLookup: React.FC = () => {
  const api = useDesktopApi();
  const [feedback, setFeedback] = useState<ScanStationFeedback>(IDLE);

  const lookUp = useCallback(
    async (code: string) => {
      const seq = feedback.seq + 1;
      try {
        setFeedback(lookupFeedback(code, await api.getQrJourney(code), seq));
      } catch {
        setFeedback({ tone: "error", title: copy.writeLease.lookupTitle, message: copy.writeLease.lookupFailed, result: null, seq });
      }
    },
    [api, feedback.seq]
  );

  const box = useScanBox({ armed: true, onScan: lookUp, refocusKey: feedback.seq });

  // Rendered inside a station frame (ReaderStation), which carries the station styles.
  return (
    <ScanPanel
      feedback={feedback}
      inputRef={box.inputRef}
      inputVal={box.inputVal}
      onInputChange={box.setInputVal}
      onKeyDown={box.onKeyDown}
      onFocusScanner={box.focusScanner}
      disabled={false}
      onSubmit={box.submit}
      submitLabel={copy.writeLease.lookupTitle}
      placeholder={copy.writeLease.lookupPlaceholder}
      dockHint={copy.writeLease.lookupHint}
    />
  );
};
