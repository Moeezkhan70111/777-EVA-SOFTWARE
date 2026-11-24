import React, { useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { addArticleColor } from "./articleColor";

// "+ New colour" above the grid: a new colour for the chosen article, on every one of its active sizes (main process
// addColorToArticle). It is product master data, written where MASTER_DATA is held; the page only shows it there.

const text = copy.stockAdjustment;

interface AddColorControlProps {
  article: string;
  /** Called with the colour as stored (upper-case) once it is on the article. */
  onAdded: (color: string) => void;
}

export const AddColorControl: React.FC<AddColorControlProps> = ({ article, onAdded }) => {
  const api = useDesktopApi();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const close = () => { setOpen(false); setName(""); setProblem(null); };

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setProblem(null);
    const reply = await addArticleColor(api, article, name, text.colorNotAdded);
    setBusy(false);
    if (!reply.ok) { setProblem(reply.reason); return; }
    close();
    onAdded(reply.color);
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost sa-add-color" aria-label={text.addColorLabel(article)} title={text.addColorLabel(article)}
        disabled={!article} onClick={() => setOpen(true)}>
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
