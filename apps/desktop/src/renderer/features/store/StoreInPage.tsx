import React, { useState } from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import { StateView } from "../../components/shared/StateView";
import { TabStrip, type TabStripItem } from "../../components/shared/TabStrip";
import { NewMaterialModal } from "../rawMaterial/NewMaterialModal";
import { RawMaterialSection } from "../rawMaterial/RawMaterialSection";
import { useRawMaterialLookups } from "../rawMaterial/useRawMaterialLookups";
import { RawMaterialInputPage } from "../../pages/RawMaterialInputPage";
import { HandMovePanel } from "./HandMovePanel";
import { ProgramLookupField } from "./programOut/ProgramLookupField";
import { ProgramOutPanel } from "./programOut/ProgramOutPanel";
import { useProgramOut } from "./programOut/useProgramOut";
import { STORE_IN_TABS, storeInTabRoute, type StoreInTab } from "./storeOperators";
import { StockIcon, ScanInIcon } from "./StoreIcons";

// STORE IN — one page for everything that comes into the store.
//
//   ┌ Store In ───────────────────────────────────────────────────────────┐
//   │ [Add New Material] [QR Generator] [Stock] [Receipts] [Setup]        │
//   ├────────────────────────────────────┬────────────────────────────────┤
//   │ the chosen section                 │ Scan Material                  │
//   │                                    │ (the Move In station, always)  │
//   └────────────────────────────────────┴────────────────────────────────┘
//
// It replaces the Move In card dashboard and the three screens under it: a tab is a tab, not a
// page to walk into and back out of. Every section is the existing implementation
// (RawMaterialSection) — nothing here creates, prints or scans by itself.
//
// The scan station on the right NEVER unmounts: every tab renders this one component in the
// same place, unkeyed, so React keeps it — and with it the open receiving session, the scan box
// and the recent scans — while the operator moves between tabs.
//
// THE MACHINE PROGRAM LOOKUP under the title is the same box as on Store Out. Here it opens the
// program VIEW ONLY, in place of the section on the left — never over the scan station, which
// keeps its receiving session. Nothing can be issued from Store In; the program is read, and
// the cartons it is owed can be printed.

export interface StoreInAccess {
  /** Creating a material, Stock and Receipts. */
  stock: boolean;
  /** Printing raw material QR labels. */
  labels: boolean;
  /** Categories, units, conversions and destinations. */
  settings: boolean;
}

interface StoreInPageProps {
  tab: StoreInTab;
  token: string;
  username?: string;
  isAdmin: boolean;
  access: StoreInAccess;
  onNavigate: (route: AppRoute) => void;
}

const allows = (tab: StoreInTab, access: StoreInAccess): boolean => {
  if (tab === "setup") return access.settings;
  if (tab === "labels") return access.labels;
  return access.stock;
};

export const StoreInPage: React.FC<StoreInPageProps> = ({ tab, token, username, isAdmin, access, onNavigate }) => {
  const lookups = useRawMaterialLookups();
  // A fresh, empty form after each material is created — the desk stays open for the next one.
  const [formKey, setFormKey] = useState(0);
  const [labelsItemId, setLabelsItemId] = useState<string | undefined>(undefined);
  // The owner's reference screen puts Manual Entry under the scanner, as the other way in.
  const [manualOpen, setManualOpen] = useState(false);
  // No issue session: nothing leaves the store from here.
  const programView = useProgramOut({ token, sessionId: null });

  const allowed = STORE_IN_TABS.filter((entry) => allows(entry.id, access));
  // A tab this operator may not open falls back to the first they may, so the page is never blank.
  const active = allowed.some((entry) => entry.id === tab) ? tab : allowed[0]?.id;
  const items: TabStripItem<StoreInTab>[] = allowed.map((entry) => ({ id: entry.id, label: entry.title }));

  const openLabelsFor = (itemId: string) => {
    setLabelsItemId(itemId);
    onNavigate(storeInTabRoute("labels"));
  };

  return (
    <div className="si-page">
      <header className="si-head">
        <span className="si-head-mark" aria-hidden="true">
          <StockIcon />
        </span>
        <div>
          <h1 className="si-title">{copy.store.storeInTitle}</h1>
          <p className="si-sub">{copy.store.storeInLine}</p>
        </div>
      </header>

      {/* Not focused on arrival: the receiving scanner on the right owns the keyboard. */}
      <ProgramLookupField
        onOpen={(lookup) => void programView.open(lookup)}
        busy={programView.loading}
        error={programView.program ? null : programView.error}
        autoFocus={false}
      />
      {programView.loading ? <StateView kind="loading" compact message={copy.programOut.opening} /> : null}

      {active ? (
        <TabStrip
          items={items}
          active={programView.program ? null : active}
          onSelect={(id) => {
            // An open program sits where the sections do: choosing a section puts it away.
            programView.close();
            onNavigate(storeInTabRoute(id));
          }}
          label={copy.store.storeInSections}
        />
      ) : null}

      <div className="si-body">
        <section className="si-main" aria-label={allowed.find((entry) => entry.id === active)?.title ?? copy.store.storeInTitle}>
          {programView.program ? (
            <ProgramOutPanel state={programView} onClose={programView.close} viewOnly />
          ) : !active ? (
            <StateView kind="empty" title={copy.store.noAccessTitle} hint={copy.store.noAccessHint} />
          ) : active === "material" ? (
            <NewMaterialForm lookups={lookups} formKey={formKey} onDone={() => setFormKey((key) => key + 1)} />
          ) : (
            <RawMaterialSection
              tab={active}
              lookups={lookups}
              username={username}
              isAdmin={isAdmin}
              onGenerateLabels={access.labels ? openLabelsFor : () => onNavigate(storeInTabRoute("labels"))}
              labelsItemId={labelsItemId}
              onLabelsItemConsumed={() => setLabelsItemId(undefined)}
              onNavigate={onNavigate}
            />
          )}
        </section>

        <aside className="si-scan" aria-label={copy.store.scanMaterialTitle}>
          <header className="si-scan-head">
            <span className="si-scan-mark" aria-hidden="true">
              <ScanInIcon />
            </span>
            <div>
              <h2 className="si-scan-title">{copy.store.scanMaterialTitle}</h2>
              <p className="si-scan-line">{copy.store.scanMaterialLine}</p>
            </div>
          </header>
          <RawMaterialInputPage token={token} username={username} embedded />

          {/* A delivery that carries no labels cannot be scanned in, so it is typed in. The
              station above stays mounted either way — an open session is not interrupted. */}
          <div className="si-manual">
            <p className="si-manual-or">
              <span>{copy.store.or}</span>
            </p>
            {manualOpen ? (
              <div className="si-manual-open">
                <header className="si-manual-head">
                  <h3 className="si-manual-title">{copy.moveOut.manualInTitle}</h3>
                  <button type="button" className="si-manual-close" onClick={() => setManualOpen(false)}>
                    {copy.common.close}
                  </button>
                </header>
                <HandMovePanel direction="IN" token={token} />
              </div>
            ) : (
              <button type="button" className="si-manual-btn" onClick={() => setManualOpen(true)}>
                {copy.store.manualEntry}
              </button>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

/** Step 1 of receiving: the material has to exist before a label can name it. */
const NewMaterialForm: React.FC<{
  lookups: ReturnType<typeof useRawMaterialLookups>;
  formKey: number;
  onDone: () => void;
}> = ({ lookups, formKey, onDone }) => {
  // Loading shows only on first arrival: a reload after adding a unit or an option mid-form
  // must not unmount the form and throw away what was typed.
  if (lookups.loading && lookups.categories.length === 0) return <StateView kind="loading" message={copy.common.loading} />;
  if (lookups.error) return <StateView kind="error" message={lookups.error} onRetry={() => void lookups.reload()} />;
  return (
    <NewMaterialModal
      key={formKey}
      layout="page"
      categories={lookups.categories}
      units={lookups.units}
      onClose={onDone}
      onCreated={lookups.reload}
      onLookupsChanged={lookups.reload}
    />
  );
};
