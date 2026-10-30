// Keeps this computer listening to the cloud log's doorbell while it syncs (packages/sync doorbell.ts,
// cloud migration 016), so another computer's work reaches it within seconds, not at its next timer.
//
// The doorbell needs a signed-in session, and the session belongs to the sync pass (cloudSyncPass.ts,
// its cached transport). So after every pass this matches the doorbell to the pass's session: started
// once there is one, restarted if the computer now syncs as someone else or with another project,
// stopped if it no longer syncs at all. A ring wakes the scheduler, which runs an ordinary pass.
//
// Only CHANGES of state are logged: a doorbell that reconnects all day would otherwise fill app.log.

import type { DoorbellStatus, SyncDoorbell } from "@erp/sync";
import type { StructuredLogger } from "@erp/data";
import { doorbellSession } from "./cloudSyncPass";

let current: { key: string; doorbell: SyncDoorbell } | null = null;
let lastStatus: DoorbellStatus = "OFF";

/** What the doorbell is doing, for the Health page. */
export const realtimeStatus = (): DoorbellStatus => lastStatus;

export async function refreshRealtimeWake(deps: {
  logger: Pick<StructuredLogger, "log">;
  deviceId: string;
  wake: () => void;
}): Promise<void> {
  const session = doorbellSession();
  const key = session === null ? null : `${session.url}|${session.anonKey}|${session.deviceId}`;
  if (current !== null && current.key === key) return;

  if (current !== null) {
    current.doorbell.stop();
    current = null;
  }
  if (session === null || key === null) return;

  const sync = await import("@erp/sync");
  const doorbell = new sync.SyncDoorbell({
    url: session.url,
    anonKey: session.anonKey,
    accessToken: session.accessToken,
    ownDeviceId: session.deviceId,
    onRing: deps.wake,
    onStatus: (status, detail) => {
      if (status === lastStatus) return;
      lastStatus = status;
      deps.logger.log({
        module: "sync",
        severity: status === "RECONNECTING" ? "WARNING" : "INFO",
        operation: "realtime",
        deviceId: deps.deviceId,
        message: `Live updates ${status.toLowerCase()}${detail ? `: ${detail}` : ""}.`,
      });
    },
  });
  current = { key, doorbell };
  doorbell.start();
}

/** Stops listening, on shutdown. */
export function stopRealtimeWake(): void {
  current?.doorbell.stop();
  current = null;
  lastStatus = "OFF";
}
