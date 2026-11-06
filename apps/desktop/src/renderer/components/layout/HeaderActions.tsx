import React from "react";
import { STORE_AVATAR_URL } from "../../config/artwork";
import { copy } from "../../config/copy";
import type { AuthUser } from "../../types/desktopApi";
import { FloatingProfileMenu } from "../../features/auth/FloatingProfileMenu";
import type { SavedProfile } from "../../features/auth/session";
import type { UserNotification } from "../../features/users/types";
import { NotificationBell, UserNotificationList, unreadCount } from "./NotificationBell";

// THE TOP RIGHT OF EVERY SCREEN: the bell and the profile, drawn the way the Store page header
// drew them first (0.4.1) — the bell in the header's blue, the profile as the header design's
// portrait opening the usual menu. The Store page carries them in its own header; every other
// screen in the app's top bar (AppTopBar). The sidebar carries neither.
//
// An administrator's access and permission requests ride in the same bell, under the user's own
// notifications, and count on its badge.

interface HeaderActionsProps {
  user: AuthUser;
  notifications: readonly UserNotification[];
  onNotificationClick: (notification: UserNotification) => void;
  savedProfiles: SavedProfile[];
  onSwitchProfile: (token: string) => Promise<void> | void;
  onAddAccount: () => void;
  onLogout: () => void;
  onChangePassword: () => void;
  onProfile: () => void;
  /** More that waits on the bell (an administrator's requests): how many, and their list. */
  requests?: { count: number; panel: React.ReactNode };
}

export const HeaderActions: React.FC<HeaderActionsProps> = ({ user, notifications, onNotificationClick, requests, ...profile }) => (
  <div className="header-actions" role="group" aria-label={copy.appHeader.label}>
    <NotificationBell label={copy.appHeader.notifications} count={unreadCount(notifications) + (requests?.count ?? 0)}>
      <div className="notification-panel-title">{copy.appHeader.notifications}</div>
      {notifications.length === 0 ? (
        <p className="notification-panel-empty">{copy.appHeader.noNotifications}</p>
      ) : (
        <UserNotificationList notifications={notifications} onNotificationClick={onNotificationClick} />
      )}
      {requests?.panel}
    </NotificationBell>
    <FloatingProfileMenu user={user} avatarSrc={STORE_AVATAR_URL} {...profile} />
  </div>
);
