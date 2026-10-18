import React, { useEffect, useMemo, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { NumberBlockSection } from "../components/settings/NumberBlockSection";
import { CloudSyncSection } from "../components/settings/CloudSyncSection";

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
    // No sync control here. Cloud sync is configured by this computer's environment, not by a
    // setting an operator can type into — and the `sync.settings` row this page used to show
    // ("disabled-phase-2") is read by nothing, so editing it never did anything. A real sync
    // status belongs here one day, backed by getCloudSyncStatus; a text box that pretends to
    // switch sync on is worse than no control at all.
    keys: ["logging.level", "sound.enabled"],
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
  "sound.enabled":        "Sound Enabled",
};

interface SettingsPageProps {
  /** Only an administrator is offered the one-time document-number range assignment. */
  isAdmin: boolean;
}

// SettingsPage no longer needs onThemeChange — theme is fixed to dark navy
export const SettingsPage = ({ isAdmin }: SettingsPageProps) => {
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
      <NumberBlockSection isAdmin={isAdmin} />
      {/* Cloud sync: what this computer has sent, and the two actions an administrator has.
          The panel shows its own status to anyone who can open Settings; the pass and the
          requeue are offered only to an administrator, as the main process requires. */}
      <CloudSyncSection isAdmin={isAdmin} />

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
