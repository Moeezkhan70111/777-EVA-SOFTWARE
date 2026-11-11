import React, { useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { leaseRefusalText } from "../../../shared/leaseRefusal";

// The "+" beside Colour: a new colour for the chosen article, on every one of its active sizes (main process
// addColorToArticle). It is product master data, written where MASTER_DATA is held; the page only shows it there.

const text = copy.stockAdjustment;

interface AddColorControlProps {
  article: string;
  /** Called with the colour as stored (upper-case) once it is on the article. */
  onAdded: (color: string) => void;
}

type Reply = { ok: true; color: string } | { ok: false; reason: string };

const readReply = (reply: unknown): Reply => {
  const record = typeof reply === "object" && reply !== null ? (reply as Record<string, unknown>) : {};
  if (record.accepted === true && typeof record.color === "string") return { ok: true, color: record.color };
  return { ok: false, reason: typeof record.reason === "string" ? record.reason : text.colorNotAdded };
};

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
    try {
      const reply = readReply(await api.addArticleColor({ article, color: name }));
      if (!reply.ok) { setProblem(reply.reason); return; }
      close();
      onAdded(reply.color);
    } catch (error) {
      setProblem(leaseRefusalText(error) ?? text.colorNotAdded);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost sa-add-color" aria-label={text.addColorLabel(article)} title={text.addColorLabel(article)}
        disabled={!article} onClick={() => setOpen(true)}>
        +
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
