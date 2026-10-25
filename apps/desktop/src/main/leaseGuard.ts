// THE LOCAL WRITE GATE for leased domains (docs/37 section W).
//
// Handler modules that write a leased domain register through the `ipcMain` exported here instead of
// Electron's. It is Electron's, with one difference: a channel listed in LEASED_CHANNELS runs only
// after this computer is found to hold every lease the channel needs. Every other channel is
// registered untouched.
//
// WHY HERE, AND NOT IN THE SCREENS. A hidden button is not an authorisation (CLAUDE.md R9). The
// screens will show leased domains read-only on a reader, but this is what makes a reader unable to
// write them, whatever the renderer sends. The cloud is still the authority: this only stops a write
// the cloud would refuse from being made at all.
//
// FAILS CLOSED. A leased channel called before installLeaseGate has run is refused, not let through:
// a wiring mistake must not turn into writes the cloud will reject.
//
// The decision itself is @erp/sync's leaseWriteDecision: standalone computers write as before, and a
// synced computer writes only as the current holder, caught up past the previous holder's last write.

import { ipcMain as electronIpcMain } from "electron";
import { LEASE_DOMAIN, type LeaseDomain } from "@erp/domain";
import type { SqliteDatabase } from "@erp/data";
import { isCloudSyncConfigured } from "./cloudSyncPass";
import { leasesFor } from "./leaseChannels";

type Listener = Parameters<typeof electronIpcMain.handle>[1];

export interface LeaseGateDeps {
  readonly db: SqliteDatabase;
  readonly deviceId: string;
  readonly dataRoot: string;
}

let gate: LeaseGateDeps | null = null;

/** Called once at startup, before any handler can run. */
export function installLeaseGate(deps: LeaseGateDeps): void {
  gate = deps;
}

const DOMAIN_WORDS: Readonly<Record<LeaseDomain, string>> = {
  [LEASE_DOMAIN.RAW_MATERIAL_STORE]: "the raw material store",
  [LEASE_DOMAIN.MASTER_DATA]: "master data (materials, units, parties and machines)",
  [LEASE_DOMAIN.SALES_DISPATCH]: "sales and dispatch",
  [LEASE_DOMAIN.ACCOUNTS]: "accounts",
  [LEASE_DOMAIN.MACHINE_PROGRAMS]: "machine programs",
  [LEASE_DOMAIN.APPROVALS]: "approvals",
};

/** A leased write refused on this computer. The message is for the operator, as it stands. */
export class LeaseError extends Error {
  readonly code = "LEASE_REQUIRED";
  constructor(
    readonly domain: LeaseDomain,
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "LeaseError";
  }
}

/** Throws a LeaseError unless this computer may write every one of `domains` now. */
export async function requireLeases(domains: readonly LeaseDomain[]): Promise<void> {
  const deps = gate;
  if (deps === null) {
    throw new LeaseError(domains[0] ?? LEASE_DOMAIN.MASTER_DATA, "NOT_READY", "This computer is still starting. Try again in a moment.");
  }
  const sync = await import("@erp/sync");
  const syncConfigured = isCloudSyncConfigured({ deviceId: deps.deviceId, dataRoot: deps.dataRoot });
  for (const domain of domains) {
    const decision = sync.leaseWriteDecision(deps.db.db, { domain, deviceId: deps.deviceId, syncConfigured });
    if (decision.allowed) continue;
    throw new LeaseError(domain, decision.reason, refusalMessage(domain, decision.reason, decision.holderLabel));
  }
}

function refusalMessage(domain: LeaseDomain, reason: string, holderLabel: string | null): string {
  const what = DOMAIN_WORDS[domain];
  switch (reason) {
    case "HELD_ELSEWHERE":
      return `${capitalise(what)} is written on ${holderLabel ?? "another computer"} only. It is read-only here.`;
    case "NOT_HELD":
      return `No computer may write ${what} right now, so it is read-only here. The owner grants it to one computer.`;
    case "CATCHING_UP":
      return `This computer writes ${what}, but is still catching up with the work done before it took over. Run Sync Now, then try again.`;
    default:
      return `This computer has not yet learned from the cloud who writes ${what}. Run Sync Now once while online, then try again.`;
  }
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Electron's ipcMain.handle, with the lease gate in front of every leased channel. */
export const ipcMain = {
  handle(channel: string, listener: Listener): void {
    const domains = leasesFor(channel);
    if (domains.length === 0) {
      electronIpcMain.handle(channel, listener);
      return;
    }
    electronIpcMain.handle(channel, async (event, ...args: unknown[]) => {
      await requireLeases(domains);
      return listener(event, ...args);
    });
  },
};
