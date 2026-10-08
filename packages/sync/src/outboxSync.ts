export interface SyncResult {
  syncedCount: number;
  failedCount: number;
}

export interface OutboxSyncPort {
  runOnce(): Promise<SyncResult>;
}

export class OutboxSyncService implements OutboxSyncPort {
  async runOnce(): Promise<SyncResult> {
    // Stub for Module B implementation.
    return { syncedCount: 0, failedCount: 0 };
  }
}
