import React from "react";
import { copy } from "../../../config/copy";
import type { StoreMode } from "./storeTabs";

// RECEIVING | ISSUING — the two halves, the full width of the page. Each says, under its name, where
// its session stands, and the inactive half says it too: a session left open on the other side is
// seen from this one. Which half is on is said by aria-pressed, never by colour alone.

/** One mode's session, as the switch shows it. */
export interface ModeSession {
  open: boolean;
  packets: number;
}

const stateLine = (session: ModeSession): string =>
  session.open ? copy.storeStation.batchOpen(session.packets) : copy.storeStation.nothingStarted;

const ModeHalf: React.FC<{ mode: StoreMode; label: string; session: ModeSession; active: boolean; onSelect: (mode: StoreMode) => void }> = ({
  mode,
  label,
  session,
  active,
  onSelect,
}) => (
  <button type="button" className={`sp-mode sp-mode--${mode}`} aria-pressed={active} onClick={() => onSelect(mode)}>
    <span className="sp-mode-name">{label}</span>
    <span className={`sp-mode-state${session.open ? " sp-mode-state--open" : ""}`}>{stateLine(session)}</span>
  </button>
);

interface ModeSwitchProps {
  mode: StoreMode;
  receiving: ModeSession;
  issuing: ModeSession;
  onSelect: (mode: StoreMode) => void;
}

export const ModeSwitch: React.FC<ModeSwitchProps> = ({ mode, receiving, issuing, onSelect }) => (
  <div className="sp-modes" role="group" aria-label={copy.storePage.modesLabel} title={copy.storePage.keyHint}>
    <ModeHalf mode="receiving" label={copy.storePage.receiving} session={receiving} active={mode === "receiving"} onSelect={onSelect} />
    <ModeHalf mode="issuing" label={copy.storePage.issuing} session={issuing} active={mode === "issuing"} onSelect={onSelect} />
  </div>
);
