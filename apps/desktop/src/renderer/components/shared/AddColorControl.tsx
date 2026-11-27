import React, { useId, useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { addArticleColor, requestArticleColor } from "./articleColor";

// "+ New colour" above the grid: a new colour for the chosen article, on every one of its active sizes (main process
// addColorToArticle). It is product master data, written where MASTER_DATA is held. A page that offers it to everyone
// (Enter Orders, owner 27 Nov 2026) passes blockedReason where it cannot be used: the button stays, turned off, and says
// who can add a colour. The main process refuses the write anywhere else regardless. With onAsked (Enter Orders on the
// orders computer, 27 Nov 2026) it ASKS the Product Master computer instead, which adds the colour by itself.

const text = copy.stockAdjustment;

interface AddColorControlProps {
  article: string;
  /** Called with the colour as stored (upper-case) once it is on the article. */
  onAdded: (color: string) => void;
  /** Why this person or computer cannot add a colour here: shown beside the button, which is turned off. */
  blockedReason?: string;
  disabled?: boolean;
  /** Ask the Product Master computer instead of adding here: called with the colour once asked. */
  onAsked?: (color: string) => void;
}

export const AddColorControl: React.FC<AddColorControlProps> = ({ article, onAdded, blockedReason, disabled = false, onAsked }) => {
  const api = useDesktopApi();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const noteId = useId();

  const close = () => { setOpen(false); setName(""); setProblem(null); };

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setProblem(null);
    if (onAsked) {
      const asked = await requestArticleColor(api, article, name, text.colorNotAdded);
      setBusy(false);
      if (!asked.ok) { setProblem(asked.reason); return; }
      close();
      if (asked.asked) onAsked(asked.color);
      else onAdded(asked.color);
      return;
    }
    const reply = await addArticleColor(api, article, name, text.colorNotAdded);
    setBusy(false);
    if (!reply.ok) { setProblem(reply.reason); return; }
    close();
    onAdded(reply.color);
  };

  if (blockedReason !== undefined) {
    return (
      <span className="add-color-blocked">
        <button type="button" className="btn btn-ghost sa-add-color" disabled aria-label={text.addColorLabel(article)} aria-describedby={noteId}>
          {text.newColorButton}
        </button>
        <span id={noteId} className="add-color-blocked-note">{blockedReason}</span>
      </span>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost sa-add-color" aria-label={text.addColorLabel(article)} title={text.addColorLabel(article)}
        disabled={!article || disabled} onClick={() => setOpen(true)}>
        {text.newColorButton}
      </button>
    );
  }

  return (
    <div className="sa-new-color" role="group" aria-label={text.addColorLabel(article)}>
      <input className="form-input" autoFocus value={name} maxLength={40} aria-label={text.newColorLabel} placeholder={text.newColorPlaceholder}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); void save(); }
          if (event.key === "Escape") close();
        }} />
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? text.addingColor : text.addColor}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={close}>{text.cancel}</button>
      {problem ? <span className="sa-problem" role="alert">⚠ {problem}</span> : null}
    </div>
  );
};
