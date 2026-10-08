import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

export type NoticeKind = "success" | "error" | "warning" | "info";

export interface NoticeItem {
  id: string;
  kind: NoticeKind;
  title: string;
  message?: string;
}

interface NoticeApi {
  notices: NoticeItem[];
  push: (kind: NoticeKind, title: string, message?: string, ttlMs?: number) => void;
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
    window.setTimeout(() => dismiss(id), ttlMs);
  }, [dismiss]);

  const value = useMemo(() => ({ notices, push, dismiss }), [notices, push, dismiss]);
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
};

export const useNotifications = (): NoticeApi => {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error("useNotifications must be used within NotificationsProvider");
  }
  return ctx;
};
