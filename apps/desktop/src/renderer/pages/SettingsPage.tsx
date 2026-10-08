import React, { useEffect, useMemo, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { useNotifications } from "../state/NotificationsContext";

const SETTINGS_GROUPS = [
  {
    label: "Factory",
    keys: ["factory.name", "factory.id", "workstation.name", "device.name"],
  },
  {
    label: "Appearance & Language",
    keys: ["language", "theme"],
  },
  {
    label: "Backup",
    keys: ["backup.folder", "backup.auto.enabled", "backup.auto.time"],
  },
  {
    label: "System",
    keys: ["logging.level", "sync.settings", "sound.enabled"],
  },
];

const FRIENDLY_LABELS: Record<string, string> = {
  "factory.name":         "Factory Name",
  "factory.id":           "Factory ID",
  "workstation.name":     "Workstation Name",
  "device.name":          "Device Name",
  "language":             "Language",
  "theme":                "Theme (light/dark)",
  "backup.folder":        "Backup Folder Path",
  "backup.auto.enabled":  "Auto Backup Enabled",
  "backup.auto.time":     "Auto Backup Time",
  "logging.level":        "Logging Level",
  "sync.settings":        "Sync Settings",
  "sound.enabled":        "Sound Enabled",
};

// SettingsPage no longer needs onThemeChange — theme is fixed to dark navy
export const SettingsPage = () => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  const load = async () => setSettings(await api.getSettings());
  useEffect(() => { void load(); }, []);

  const set = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const save = async () => {
    await api.saveSettings(settings);
    push("success", "Settings Saved");
    setDirty(false);
  };

  const doBackup = async () => {
    const backup = await api.createBackup();
    push("info", "Backup Created", backup.backupPath);
  };

  const resetDatabase = async () => {
    const confirmed = window.confirm("Reset the local database? This permanently deletes every record — products, QR codes, gatepasses, bills, vouchers, ledgers, users — plus settings, product images and saved sign-ins. Backups are kept. The app will restart.");
    if (!confirmed) return;
    await api.resetDatabase();
  };

  return (
    <div className="stack">
      {SETTINGS_GROUPS.map((group) => (
        <div className="settings-section" key={group.label}>
          <div className="settings-section-title">{group.label}</div>
          <div className="settings-grid">
            {group.keys.map((key) => (
              <div className="input-group" key={key}>
                <label className="input-label" htmlFor={`setting-${key}`}>{FRIENDLY_LABELS[key] ?? key}</label>
                <input
                  id={`setting-${key}`}
                  value={settings[key] ?? ""}
                  onChange={(e) => set(key, e.target.value)}
                  placeholder={FRIENDLY_LABELS[key] ?? key}
                />
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Actions */}
      <div className="row" style={{ paddingTop: 8 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={!dirty}
        >
          {dirty ? "Save Changes" : "Saved"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void doBackup()}
        >
          Create Backup
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => void resetDatabase()}
        >
          Reset Database
        </button>
      </div>
    </div>
  );
};
