// Tells every open window what kind of data just changed underneath it (shared/dataChange.ts).
//
// Called after a sync pass applies data from another computer. A window that has gone away is
// skipped: the message is a nudge to reload, and there is nobody left to nudge.

//
// Each announcement carries a new id and says how many windows it reached, so the pass can log it
// and a screen's trace (IPC.traceDataChange) can be matched to it in app.log.

import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { IPC } from "../shared/ipcChannels";
import type { DataChange, DataKind } from "../shared/dataChange";

export interface Announcement {
  readonly id: string;
  readonly windows: number;
}

export function announceDataChanged(kinds: readonly DataKind[]): Announcement | null {
  if (kinds.length === 0) return null;
  const change: DataChange = { kinds, id: randomUUID() };
  let windows = 0;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(IPC.dataChanged, change);
    windows += 1;
  }
  return { id: change.id ?? "", windows };
}
