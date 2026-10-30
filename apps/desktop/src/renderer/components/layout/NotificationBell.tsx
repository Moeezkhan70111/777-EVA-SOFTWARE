import React, { useCallback, useRef, useState } from "react";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";
import type { UserNotification } from "../../features/users/types";

// THE BELL: one trigger, its count, and the panel it opens -- the navbar's and the Store page
// header's (0.4.1). What the panel lists is the caller's: the navbar adds an administrator's access
// and permission requests below the user's own notifications.

interface NotificationBellProps {
  /** The trigger's accessible name. */
  label: string;
  /** What is waiting: shown on the badge, which is absent at 0. */
  count: number;
  children: React.ReactNode;
  className?: string;
}

export const NotificationBell: React.FC<NotificationBellProps> = ({ label, count, children, className }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  // Closes on a click anywhere else on the screen, or on Escape.
  useDismissOnOutsideClick(ref, open, close);

  return (
    <div className={`notification-menu-wrap${className ? ` ${className}` : ""}`} ref={ref}>
      <button
        type="button"
        className="notification-trigger"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        {count > 0 && <span className="notification-badge">{count}</span>}
      </button>
      {open && <div className="notification-panel">{children}</div>}
    </div>
  );
};

/** How many of a user's notifications are unread. */
export const unreadCount = (notifications: readonly UserNotification[]): number =>
  notifications.filter((notification) => !notification.readAt).length;

interface UserNotificationListProps {
  notifications: readonly UserNotification[];
  onNotificationClick?: (notification: UserNotification) => void;
}

/** The user's own notifications, newest as the caller orders them. Each opens on click or Enter. */
export const UserNotificationList: React.FC<UserNotificationListProps> = ({ notifications, onNotificationClick }) => (
  <>
    {notifications.map((notification) => (
      <div
        className={`user-notification${notification.readAt ? " read" : ""}${notification.severity === "CRITICAL" ? " is-critical" : notification.severity === "WARNING" ? " is-warning" : ""}`}
        key={notification.id}
        role="button"
        tabIndex={0}
        onClick={() => onNotificationClick?.(notification)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onNotificationClick?.(notification);
          }
        }}
      >
        <strong>
          {notification.severity === "CRITICAL" ? "⚠ " : ""}
          {notification.title}
        </strong>
        <span>{notification.message}</span>
      </div>
    ))}
  </>
);
