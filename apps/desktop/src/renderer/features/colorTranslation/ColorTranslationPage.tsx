import React, { useMemo, useState } from "react";
import { buildColorDictionary, normalizeColorKey, normalizeUrduText, type ColorTranslation } from "@erp/domain";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useNotifications } from "../../state/NotificationsContext";
import { RAIL_ICONS } from "../navigation/NavIcons";
import { ColorTranslationForm, colorRefusalText } from "./ColorTranslationForm";
import { LegacyCorrections } from "./LegacyCorrections";
import { pendingLegacyCorrections, type LegacyCorrection } from "./legacyColorCorrections";
import { useColorTranslations } from "./useColorTranslations";
import type { ColorWriteReply } from "./colorTranslationReply";

// COLOR TRANSLATION: the shared list of what each English colour is called in Urdu (docs/45). Carton Stock and the
// carton and raw material labels read it. Changing it needs Settings or Raw Material Setup, checked by the main
// process, and this computer must hold the master-data lease.

const text = copy.colorTranslation;

/** By English (any case, any spacing) or by Urdu (as written). */
export const filterColorTranslations = (rows: readonly ColorTranslation[], search: string): ColorTranslation[] => {
  const english = normalizeColorKey(search);
  const urdu = normalizeUrduText(search);
  if (!english) return [...rows];
  return rows.filter((row) => normalizeColorKey(row.englishName).includes(english) || normalizeUrduText(row.urduName).includes(urdu));
};

type Editing = { mode: "add" } | { mode: "edit"; row: ColorTranslation } | null;

const Rows: React.FC<{ rows: readonly ColorTranslation[]; onEdit: (row: ColorTranslation) => void; onDelete: (row: ColorTranslation) => void }> = ({ rows, onEdit, onDelete }) => (
  <div className="table-container">
    <table className="data-table ct-table" aria-label={text.tableLabel}>
      <thead>
        <tr>
          <th scope="col">{text.english}</th>
          <th scope="col">{text.urdu}</th>
          <th scope="col" className="ct-actions-col">{text.actions}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td className="ct-english">{row.englishName}</td>
            <td><span className="urdu-text" lang="ur" dir="rtl">{row.urduName}</span></td>
            <td className="ct-actions">
              <button type="button" className="btn btn-secondary btn-sm" aria-label={text.editLabel(row.englishName)} onClick={() => onEdit(row)}>{text.edit}</button>
              <button type="button" className="btn btn-danger btn-sm" aria-label={text.deleteLabel(row.englishName)} onClick={() => onDelete(row)}>{text.delete}</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const ColorTranslationPage: React.FC = () => {
  const { push } = useNotifications();
  const list = useColorTranslations(text.failed);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<ColorTranslation | null>(null);
  const [accepting, setAccepting] = useState(false);

  const rows = useMemo(() => filterColorTranslations(list.translations ?? [], search), [list.translations, search]);
  const learned = useMemo(() => pendingLegacyCorrections(buildColorDictionary(list.translations ?? [])), [list.translations]);

  const saved = (reply: ColorWriteReply, title: string): ColorWriteReply => {
    if (reply.ok) push("success", title, "");
    return reply;
  };

  const accept = async (correction: LegacyCorrection) => {
    const existing = list.translations?.find((row) => normalizeColorKey(row.englishName) === correction.englishKey);
    setAccepting(true);
    try {
      const reply = existing
        ? await list.update(existing.id, existing.englishName, correction.urdu)
        : await list.create(correction.englishKey.toUpperCase(), correction.urdu);
      if (reply.ok) push("success", text.saved, correction.englishKey.toUpperCase());
      else push("error", text.notSaved, colorRefusalText(reply));
    } finally {
      setAccepting(false);
    }
  };

  const body = () => {
    if (list.error && !list.translations) return <StateView kind="error" title={text.failed} message={list.error} onRetry={() => void list.reload()} />;
    if (!list.translations) return <StateView kind="loading" message={text.loading} />;
    if (list.translations.length === 0) return <StateView kind="empty" title={text.emptyTitle} hint={text.emptyHint} action={{ label: text.add, onClick: () => setEditing({ mode: "add" }) }} />;
    if (rows.length === 0) return <StateView kind="empty" title={text.noMatchTitle} hint={text.noMatchHint} />;
    return <Rows rows={rows} onEdit={(row) => setEditing({ mode: "edit", row })} onDelete={setDeleting} />;
  };

  return (
    <div className="page-stack color-translation-page">
      <div className="cs-panel">
        <div className="cs-toolbar">
          <label className="us-search cs-search">
            <span className="us-search-icon" aria-hidden="true">{RAIL_ICONS.search}</span>
            <input type="search" aria-label={text.searchLabel} placeholder={text.searchPlaceholder} value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ mode: "add" })}>{text.add}</button>
        </div>
        {body()}
        <LegacyCorrections corrections={learned} onAccept={(correction) => void accept(correction)} busy={accepting} />
      </div>

      {editing ? (
        <ColorTranslationForm
          initial={editing.mode === "edit" ? editing.row : undefined}
          onClose={() => setEditing(null)}
          onSave={async (englishName, urduName) =>
            saved(editing.mode === "edit" ? await list.update(editing.row.id, englishName, urduName) : await list.create(englishName, urduName), text.saved)
          }
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={text.deleteTitle}
          facts={[
            { label: text.english, value: deleting.englishName },
            { label: text.urdu, value: deleting.urduName },
          ]}
          explain={text.deleteExplain}
          confirmLabel={text.deleteConfirm}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const reply = saved(await list.remove(deleting.id), text.deleted);
            return reply.ok ? null : colorRefusalText(reply);
          }}
        />
      ) : null}
    </div>
  );
};
