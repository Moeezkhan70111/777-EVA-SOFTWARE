import React from "react";
import { ReadOnlyNotice } from "../../components/shared/ReadOnlyNotice";
import type { WriteLeaseStatus } from "../../types/desktopApi";
import { SCAN_STATION_CSS, StationToolbar } from "../scanStation/scanStation";
import { PacketLookup } from "./PacketLookup";

// What a store scan station becomes on a READER (docs/37 section W): the same toolbar, so the way
// back is where it always is, then why it is read-only, then a scan box that only looks packets up.

interface ReaderStationProps {
  status: WriteLeaseStatus | null;
  /** As the station's own toolbar has them. Left out where the screen around it names the station. */
  eyebrow?: string;
  title?: string;
  onBack?: () => void;
  embedded?: boolean;
}

export const ReaderStation: React.FC<ReaderStationProps> = ({ status, eyebrow, title, onBack, embedded = false }) => (
  <div className={`ssn${embedded ? " ssn--embedded" : ""}`}>
    <style>{SCAN_STATION_CSS}</style>
    <StationToolbar eyebrow={eyebrow} title={title} onBack={onBack} />
    <ReadOnlyNotice status={status} />
    <PacketLookup />
  </div>
);
