import React from "react";
import { useNotifications } from "../../state/NotificationsContext";

export const NotificationCenter = () => {
  const { notices, dismiss } = useNotifications();

  return (
    <div className="notice-wrap" aria-live="polite" aria-label="Notifications">
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.kind}`} role="status">
          <div className="notice-head">
            <span className="notice-title">{n.title}</span>
            <button
              type="button"
              className="notice-dismiss"
              onClick={() => dismiss(n.id)}
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
          {n.message ? <div className="notice-body">{n.message}</div> : null}
        </div>
      ))}
    </div>
  );
};
