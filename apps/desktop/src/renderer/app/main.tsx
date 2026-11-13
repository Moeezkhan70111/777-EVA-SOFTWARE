import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { NotificationsProvider } from "../state/NotificationsContext";
import { UpdateStatusProvider } from "../state/UpdateStatusContext";
import { AppUpdateWatcher } from "../hooks/useAppUpdate";
import "../styles/theme.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <NotificationsProvider>
      {/* One update-status read for the window: the Restart prompt and the rail's Update button. */}
      <UpdateStatusProvider>
        <AppUpdateWatcher />
        <App />
      </UpdateStatusProvider>
    </NotificationsProvider>
  </React.StrictMode>
);
