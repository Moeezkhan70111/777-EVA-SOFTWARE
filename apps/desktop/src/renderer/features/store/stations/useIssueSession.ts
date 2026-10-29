import { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { copy } from "../../../config/copy";
import type { RawMaterialIssueSession, RawMaterialIssueSessionRow, RawMaterialIssueSessionSummary } from "../../../types/desktopApi";

// THE ISSUE SESSION and its party lock (0.3.8), for the issuing station.
//
//   partyId         the party chosen in the picker
//   sessionPartyId  the party the open session was started for; while set, the choice is locked
//
// On arrival: today's open session on this computer, if there is one, never a new one. A session
// with packets in it is locked to their party again, so a restart mid-session picks up where it
// was. Start issuing closes any other session still open here (the main process does that).

export interface IssueSession {
  session: RawMaterialIssueSession | null;
  summary: RawMaterialIssueSessionSummary | null;
  partyId: string;
  setPartyId: (partyId: string) => void;
  sessionPartyId: string | null;
  locked: boolean;
  sessionError: string | null;
  lastSession: RawMaterialIssueSessionRow | null;
  reload: () => Promise<void>;
  startSession: () => Promise<void>;
  /** True once the session is closed. */
  endSession: () => Promise<boolean>;
  refreshSummary: (sessionId: string) => Promise<void>;
}

export const useIssueSession = ({ token, onStarted }: { token: string; onStarted: () => void }): IssueSession => {
  const api = useDesktopApi();
  const [session, setSession] = useState<RawMaterialIssueSession | null>(null);
  const [summary, setSummary] = useState<RawMaterialIssueSessionSummary | null>(null);
  const [partyId, setPartyId] = useState("");
  const [sessionPartyId, setSessionPartyId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [lastSession, setLastSession] = useState<RawMaterialIssueSessionRow | null>(null);

  const refreshSummary = useCallback(async (sessionId: string) => setSummary(await api.getRawMaterialIssueSessionSummary(sessionId)), [api]);

  // The last session this computer closed. Not knowing it only hides Reprint, so a failure is quiet.
  const refreshLast = useCallback(async () => {
    try {
      const rows = await api.listRawMaterialIssueSessions({ thisComputerOnly: true, status: "CLOSED", limit: 1 });
      setLastSession(rows[0] ?? null);
    } catch {
      setLastSession(null);
    }
  }, [api]);

  const reload = useCallback(async () => {
    setSessionError(null);
    void refreshLast();
    try {
      const open = await api.getOpenRawMaterialIssueSession();
      setSession(open);
      if (!open) return;
      const current = await api.getRawMaterialIssueSessionSummary(open.id);
      setSummary(current);
      if (current?.partyId) {
        setPartyId(current.partyId);
        setSessionPartyId(current.partyId);
      }
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    }
  }, [api, refreshLast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const startSession = useCallback(async () => {
    if (!partyId) return;
    setSessionError(null);
    try {
      const result = await api.startRawMaterialIssueSession({ token, startNew: true });
      if (!result.accepted || !result.session) {
        setSessionError(result.reason ?? "The session could not be started.");
        return;
      }
      setSession(result.session);
      setSessionPartyId(partyId);
      onStarted();
      await refreshSummary(result.session.id);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    }
  }, [api, onStarted, partyId, refreshSummary, token]);

  const endSession = useCallback(async () => {
    if (!session) return false;
    setSession(await api.closeRawMaterialIssueSession(session.id));
    // The party is free again: the next session can be for anyone.
    setSessionPartyId(null);
    await refreshSummary(session.id);
    await refreshLast();
    return true;
  }, [api, refreshLast, refreshSummary, session]);

  const locked = session?.status === "OPEN" && sessionPartyId !== null;

  return { session, summary, partyId, setPartyId, sessionPartyId, locked, sessionError, lastSession, reload, startSession, endSession, refreshSummary };
};
