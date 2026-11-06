import React from "react";
import { copy } from "../../config/copy";
import { PlusIcon } from "../scanStation/scanStation";

// The one big button inside a Store page scan panel (1 Nov 2026), on Move in and Move out alike:
// Start Session in blue until a session is open, then End Session in the Store's red.

interface ScanSessionButtonProps {
  /** A session is open: the button ends it. */
  open: boolean;
  busy?: boolean;
  onStart: () => void;
  onEnd: () => void;
}

export const ScanSessionButton: React.FC<ScanSessionButtonProps> = ({ open, busy = false, onStart, onEnd }) =>
  open ? (
    <button type="button" className="ssn-btn ssn-btn--hero ssn-btn--end-session" onClick={onEnd} disabled={busy}>
      {copy.store.endSession}
    </button>
  ) : (
    // Pressed with no party chosen, the station says to choose one, so it stays at full strength
    // rather than greyed out with no reason given.
    <button type="button" className="ssn-btn ssn-btn--hero" onClick={onStart} disabled={busy}>
      <PlusIcon />
      {copy.store.startSession}
    </button>
  );
