// Tells every open window what kind of data just changed underneath it (shared/dataChange.ts).
//
// Called after a sync pass applies data from another computer. A window that has gone away is
// skipped: the message is a nudge to reload, and there is nobody left to nudge.

import { BrowserWindow } from "electron";
import { IPC } from "../shared/ipcChannels";
import type { DataChange, DataKind } from "../shared/dataChange";

export function announceDataChanged(kinds: readonly DataKind[]): void {
  if (kinds.length === 0) return;
  const change: DataChange = { kinds };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(IPC.dataChanged, change);
  }
}
