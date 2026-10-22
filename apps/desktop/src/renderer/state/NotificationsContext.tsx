import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

export type NoticeKind = "success" | "error" | "warning" | "info";

/** One button on a notice. Used by notices that ask for something, not just report it. */
export interface NoticeAction {
  label: string;
  onClick: () => void;
}

export interface NoticeItem {
  id: string;
  kind: NoticeKind;
  title: string;
  message?: string;
  action?: NoticeAction;
}

interface NoticeApi {
  notices: NoticeItem[];
  /** `ttlMs = 0` keeps the notice until it is dismissed — for anything that asks a question. */
  push: (kind: NoticeKind, title: string, message?: string, ttlMs?: number) => void;
  /**
   * A notice carrying a button, kept until dismissed.
   *
   * `key` replaces any earlier notice pushed under the same key instead of stacking a second
   * copy, so a poll that keeps reporting the same thing shows it once.
   */
  pushAction: (key: string, kind: NoticeKind, title: string, message: string | undefined, action: NoticeAction) => void;
  dismiss: (id: string) => void;
}

const NotificationsContext = createContext<NoticeApi | undefined>(undefined);

export const NotificationsProvider = ({ children }: { children: React.ReactNode }) => {
  const [notices, setNotices] = useState<NoticeItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const push = useCallback((kind: NoticeKind, title: string, message?: string, ttlMs = 3800) => {
    const id = crypto.randomUUID();
    setNotices((prev) => [{ id, kind, title, message }, ...prev].slice(0, 6));
    // 0 means "leave it there": a notice that asks a question must not vanish while the operator
    // is reading it.
    if (ttlMs > 0) window.setTimeout(() => dismiss(id), ttlMs);
  }, [dismiss]);

  const pushAction = useCallback(
    (key: string, kind: NoticeKind, title: string, message: string | undefined, action: NoticeAction) => {
      // Keyed, so a poll reporting the same state every minute replaces its notice rather than
      // filling the stack with identical copies and pushing everything else out.
      setNotices((prev) => [{ id: key, kind, title, message, action }, ...prev.filter((n) => n.id !== key)].slice(0, 6));
    },
    []
  );

  const value = useMemo(() => ({ notices, push, pushAction, dismiss }), [notices, push, pushAction, dismiss]);
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
};

export const useNotifications = (): NoticeApi => {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error("useNotifications must be used within NotificationsProvider");
  }
  return ctx;
};
