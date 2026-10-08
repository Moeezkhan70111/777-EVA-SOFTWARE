import React, { useState } from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import { StateView } from "../../components/shared/StateView";
import { NewMaterialModal } from "../rawMaterial/NewMaterialModal";
import { LabelsTab } from "../rawMaterial/LabelsTab";
import { useRawMaterialLookups } from "../rawMaterial/useRawMaterialLookups";
import { RawMaterialInputPage } from "../../pages/RawMaterialInputPage";
import { StoreTopBar } from "./StoreTopBar";
import { ArrowLeftIcon, NewMaterialIcon, QrLabelIcon } from "./StoreIcons";

// The Move In desk: a split screen for receiving a delivery.
//
//   ┌──────────────────────────────┬─────────────────────────┐
//   │ Add Raw Material / QR labels │ Raw Material Input       │
//   │ (switch with the two buttons)│ scanner — always open    │
//   └──────────────────────────────┴─────────────────────────┘
//
// The left half switches between the new-material form and the label generator; the right
// half is the Raw Material Input station and NEVER unmounts. Both routes render this one
// component in the same place, so React keeps it — and with it the open receiving session,
// the scan box and the recent scans — while the operator goes back and forth on the left.
//
// Every piece is the existing implementation: the workspace's form, its Labels tab and the
// scan station. Nothing here creates, prints or scans by itself.

export type DeskPane = "material" | "labels";

export const DESK_ROUTE: Record<DeskPane, AppRoute> = {
  material: "store-in-new-material",
  labels: "store-in-qr-generator",
};

interface MoveInDeskPageProps {
  pane: DeskPane;
  token: string;
  username?: string;
  /** Which halves this operator may use; the main process checks the same permissions. */
  access: { stock: boolean; labels: boolean };
  onNavigate: (route: AppRoute) => void;
}

export const MoveInDeskPage: React.FC<MoveInDeskPageProps> = ({ pane, token, username, access, onNavigate }) => {
  const lookups = useRawMaterialLookups();
  // A fresh, empty form after each material is created — the desk stays open for the next one.
  const [formKey, setFormKey] = useState(0);

  const switcher = (
    <div className="so-desk-switch" role="group" aria-label={copy.store.deskSwitch}>
      <DeskSwitchButton
        active={pane === "material"}
        disabled={!access.stock}
        icon={<NewMaterialIcon />}
        label={copy.store.addMaterialTitle}
        onClick={() => onNavigate(DESK_ROUTE.material)}
      />
      <DeskSwitchButton
        active={pane === "labels"}
        disabled={!access.labels}
        icon={<QrLabelIcon />}
        label={copy.store.qrTitle}
        onClick={() => onNavigate(DESK_ROUTE.labels)}
      />
    </div>
  );

  return (
    <div className="so-page so-desk">
      <StoreTopBar
        toolbar={
          <>
            <button type="button" className="so-back" onClick={() => onNavigate("store-in-operator")}>
              <ArrowLeftIcon />
              {copy.store.moveInTitle}
            </button>
            {switcher}
          </>
        }
      />

      <div className="so-desk-split">
        <section className="so-desk-pane so-desk-left" aria-label={pane === "material" ? copy.store.addMaterialTitle : copy.store.qrTitle}>
          {/* Loading shows only on first arrival: a reload after adding a unit or an option
              mid-form must not unmount the form and throw away what was typed. */}
          {lookups.loading && lookups.categories.length === 0 ? (
            <StateView kind="loading" message={copy.common.loading} />
          ) : lookups.error ? (
            <StateView kind="error" message={lookups.error} onRetry={() => void lookups.reload()} />
          ) : pane === "material" ? (
            <NewMaterialModal
              key={formKey}
              layout="page"
              categories={lookups.categories}
              units={lookups.units}
              onClose={() => setFormKey((key) => key + 1)}
              onCreated={lookups.reload}
              onLookupsChanged={lookups.reload}
            />
          ) : (
            <LabelsTab
              username={username}
              configByItem={lookups.configByItem}
              onPreselectConsumed={() => {}}
              units={lookups.units}
              onLookupsChanged={lookups.reload}
            />
          )}
        </section>

        <section className="so-desk-pane so-desk-right" aria-label={copy.store.scannerTitle}>
          <RawMaterialInputPage token={token} username={username} embedded />
        </section>
      </div>
    </div>
  );
};

interface DeskSwitchButtonProps {
  active: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

const DeskSwitchButton: React.FC<DeskSwitchButtonProps> = ({ active, disabled, icon, label, onClick }) => (
  <button
    type="button"
    className={`so-desk-switch-btn${active ? " is-active" : ""}`}
    aria-pressed={active}
    disabled={disabled || active}
    onClick={onClick}
  >
    <span className="so-desk-switch-icon">{icon}</span>
    {label}
  </button>
);
