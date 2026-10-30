import React from "react";
import { NotificationBell, UserNotificationList, unreadCount } from "../../../components/layout/NotificationBell";
import { STORE_AVATAR_URL } from "../../../config/artwork";
import { copy } from "../../../config/copy";
import type { AuthUser } from "../../../types/desktopApi";
import { FloatingProfileMenu } from "../../auth/FloatingProfileMenu";
import type { SavedProfile } from "../../auth/session";
import type { UserNotification } from "../../users/types";

// The right of the Store header for a store operator (0.4.1), who works without the navbar: the
// bell with their notifications (a program notification opens that program on the page), and the
// profile, drawn as the header design's portrait, opening the usual menu.

interface StoreHeaderActionsProps {
  user: AuthUser;
  notifications: readonly UserNotification[];
  onNotificationClick: (notification: UserNotification) => void;
  savedProfiles: SavedProfile[];
  onSwitchProfile: (token: string) => Promise<void> | void;
  onAddAccount: () => void;
  onLogout: () => void;
  onChangePassword: () => void;
  onProfile: () => void;
}

export const StoreHeaderActions: React.FC<StoreHeaderActionsProps> = ({ user, notifications, onNotificationClick, ...profile }) => (
  <>
    <NotificationBell label={copy.storePage.notifications} count={unreadCount(notifications)}>
      <div className="notification-panel-title">{copy.storePage.notifications}</div>
      {notifications.length === 0 ? (
        <p className="notification-panel-empty">{copy.storePage.noNotifications}</p>
      ) : (
        <UserNotificationList notifications={notifications} onNotificationClick={onNotificationClick} />
      )}
    </NotificationBell>
    <FloatingProfileMenu user={user} avatarSrc={STORE_AVATAR_URL} {...profile} />
  </>
);
