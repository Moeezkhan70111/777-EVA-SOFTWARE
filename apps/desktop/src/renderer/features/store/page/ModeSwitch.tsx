import React from "react";
import { copy } from "../../../config/copy";
import { MoveInIcon, MoveOutIcon } from "../StoreIcons";
import type { StoreMode } from "./storeTabs";

// MOVE IN | MOVE OUT (0.4.2, the owner's design) — one pill under STORE, the active half filled
// blue. A session open on either half shows as a small "Open · n" chip, so one left open on the
// other side is still seen from this one; the full state line is there for screen readers. Which
// half is on is said by aria-pressed, never by colour alone.

/** One mode's session, as the switch shows it. */
export interface ModeSession {
  open: boolean;
  packets: number;
}

const stateLine = (session: ModeSession): string =>
  session.open ? copy.storeStation.sessionOpen(session.packets) : copy.storeStation.nothingStarted;

const MODE_ICONS: Record<StoreMode, React.FC> = { receiving: MoveInIcon, issuing: MoveOutIcon };

const ModeHalf: React.FC<{ mode: StoreMode; label: string; session: ModeSession; active: boolean; onSelect: (mode: StoreMode) => void }> = ({
  mode,
  label,
  session,
  active,
  onSelect,
}) => {
  const Icon = MODE_ICONS[mode];
  return (
    <button type="button" className={`sp-mode sp-mode--${mode}`} aria-pressed={active} onClick={() => onSelect(mode)}>
      <span className="sp-mode-icon"><Icon /></span>
      <span className="sp-mode-name">{label}</span>
      {session.open ? <span className="sp-mode-chip" aria-hidden="true">{copy.storePage.modeOpen(session.packets)}</span> : null}
      <span className="sr-only">{stateLine(session)}</span>
    </button>
  );
};

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
