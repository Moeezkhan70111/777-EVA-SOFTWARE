import React from "react";
import { copy } from "../../config/copy";
import { DocumentNavigator, type DocumentNavigatorLabels } from "../../components/shared/DocumentNavigator";

// The document pager, for the Gatepass number — the shared control (components/shared/DocumentNavigator.tsx).
//
//   ◄  [ GP- 42   of 57 ]  ►  Load        a stored document
//   ◄  [ GP- 58   new    ]  ►  Load        the one being written now
//
// Gatepass numbers are assigned in order and never reused, so ◄ ► step by one and the new one is latest + 1.

const LABELS: DocumentNavigatorLabels = {
  group: copy.gatepass.navigator,
  number: copy.gatepass.gatepassNumber,
  previous: copy.gatepass.previousGatepass,
  next: copy.gatepass.nextGatepass,
  load: copy.gatepass.load,
  placeholder: copy.gatepass.numberPlaceholder,
  ofLatest: copy.gatepass.ofLatest,
  unsaved: copy.gatepass.unsavedNumber,
};

interface GatepassNavigatorProps {
  /** Number of the document on screen; null while writing a new one. */
  current: number | null;
  /** Highest number that exists (0 when none); null until known. */
  latest: number | null;
  busy: boolean;
  onGo: (gatepassNumber: number) => void;
  /** › past the latest document: back to the new one. */
  onNew: () => void;
}

export const GatepassNavigator: React.FC<GatepassNavigatorProps> = ({ current, latest, busy, onGo, onNew }) => (
  <DocumentNavigator prefix="GP -" labels={LABELS} current={current} latest={latest} busy={busy} onGo={onGo} onNew={onNew} testIdPrefix="gatepass" compact />
);
