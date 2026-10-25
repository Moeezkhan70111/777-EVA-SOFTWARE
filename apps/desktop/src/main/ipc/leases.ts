// IPC handler for the write-lease status the screens show (docs/37 section W).
//
// A read: whether this computer may write each enforced domain now, and who does. The screens use
// it to show a leased domain read-only on a reader and to swap a scan station for a lookup. It
// authorises nothing -- leaseGuard.ts refuses the write itself, whatever the screen shows.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import { ENFORCED_LEASE_DOMAINS } from "../leaseChannels";
import { writeLeaseStatuses } from "../leaseGuard";
import type { IpcContext } from "./context";

export function registerLeaseHandlers(_ctx: IpcContext): void {
  ipcMain.handle(IPC.getWriteLeases, () => writeLeaseStatuses(ENFORCED_LEASE_DOMAINS));
}
