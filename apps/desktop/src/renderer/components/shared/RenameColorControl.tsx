import React, { useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useOptionalNotifications } from "../../state/NotificationsContext";
import { ColorSwatch } from "./ColorSwatch";
import { Modal } from "./Modal";
import { renameArticleColor } from "./articleColor";

// "Rename colour", beside "− Remove colour" (owner, 28 Nov 2026: "give an option to edit a color name in all the
// places where it is needed"). Pick one of the article's colours, type its new name (pre-filled with the old one, so a
// typo is fixed in place), confirm. The main process decides: every size of the article takes the name, the products
// and everything recorded against them kept; a name another colour of the article already has is refused, in its own
// words, here. Shown by the same rule as "+ New colour" (useCanAddColour).

const words = copy.renameColour;

interface RenameColorControlProps {
  article: string;
  /** The article's colours as the page shows them. */
  colours: readonly string[];
  /** Called with the new name once the article has it. */
  onRenamed: (color: string) => void;
}

interface DialogProps extends RenameColorControlProps {
  onClose: () => void;
}

const RenameColorDialog: React.FC<DialogProps> = ({ article, colours, onRenamed, onClose }) => {
  const api = useDesktopApi();
  const notices = useOptionalNotifications();
  const [chosen, setChosen] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = Boolean(chosen) && name.trim() !== "" && name.trim().toUpperCase() !== chosen && !busy;

  const choose = (colour: string) => {
    setChosen(colour);
    setName(colour);
    setProblem(null);
  };

  const rename = async () => {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    const reply = await renameArticleColor(api, article, chosen, name, words.failed);
    setBusy(false);
    if (!reply.ok) { setProblem(reply.reason); return; }
    notices?.push("success", words.renamedTitle(chosen, reply.color, article), words.renamedMessage(reply.renamed));
    onClose();
    onRenamed(reply.color);
  };

  // The dialog's own Cancel sits beside it (Modal).
  const footer = <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => void rename()}>{busy ? words.renaming : words.confirm}</button>;

  return (
    <Modal themed title={words.title(article)} subtitle={words.subtitle} onClose={onClose} footer={footer}>
      <div className="rc-colours rc-colours--rename" role="radiogroup" aria-label={words.pick}>
        {colours.map((colour) => (
          <button key={colour} type="button" role="radio" aria-checked={colour === chosen} className={colour === chosen ? "rc-colour is-on" : "rc-colour"}
            onClick={() => choose(colour)}>
            <ColorSwatch color={colour} /><span className="rc-colour-name">{colour}</span>
          </button>
        ))}
      </div>
      {chosen ? (
        <form className="form-field rn-name" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
          <label htmlFor="rename-colour-name">{words.newName}</label>
          <input id="rename-colour-name" className="form-input" value={name} placeholder={words.newNamePlaceholder} maxLength={40} autoComplete="off" autoFocus
            aria-invalid={Boolean(problem)} aria-describedby={problem ? "rename-colour-problem" : undefined}
            onChange={(event) => { setName(event.target.value); setProblem(null); }} onFocus={(event) => event.target.select()} />
        </form>
      ) : null}
      <p className="rc-explain">{chosen ? words.explain(article, chosen) : words.choose}</p>
      <p className="field-help">{words.rule}</p>
      {problem ? <p id="rename-colour-problem" className="error-message" role="alert">⚠ {problem}</p> : null}
    </Modal>
  );
};

export const RenameColorControl: React.FC<RenameColorControlProps> = (props) => {
  const [open, setOpen] = useState(false);
  if (props.colours.length === 0) return null;
  return (
    <>
      <button type="button" className="btn btn-ghost sa-add-color rc-open" aria-label={words.buttonLabel(props.article)} title={words.buttonLabel(props.article)}
        onClick={() => setOpen(true)}>
        {words.button}
      </button>
      {open ? <RenameColorDialog {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
};
