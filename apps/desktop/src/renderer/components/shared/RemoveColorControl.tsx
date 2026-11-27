import React, { useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useOptionalNotifications } from "../../state/NotificationsContext";
import { colorToUrdu } from "@erp/domain";
import { useColorDictionary } from "../../features/colorTranslation/colorDictionaryStore";
import { ColorSwatch } from "./ColorSwatch";
import { Modal } from "./Modal";
import { removeArticleColor } from "./articleColor";

// "− Remove colour", beside "+ New colour" (owner, 27 Nov 2026: "there is no way to delete colors of articles"). Pick
// one of the article's colours, read what happens, confirm. The main process decides: the colour comes off every
// size, disabled and never deleted, and only while no size holds carton stock and no open order waits for it; a
// refusal is shown here in its own words. Shown by the same rule as "+ New colour" (useCanAddColour).

const words = copy.removeColour;

interface RemoveColorControlProps {
  article: string;
  /** The article's colours as the page shows them. */
  colours: readonly string[];
  /** Called with the colour as stored once it is off the article. */
  onRemoved: (color: string) => void;
}

interface DialogProps extends RemoveColorControlProps {
  onClose: () => void;
}

const RemoveColorDialog: React.FC<DialogProps> = ({ article, colours, onRemoved, onClose }) => {
  const api = useDesktopApi();
  const notices = useOptionalNotifications();
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dictionary = useColorDictionary();

  const remove = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setProblem(null);
    const reply = await removeArticleColor(api, article, chosen, words.failed);
    setBusy(false);
    if (!reply.ok) { setProblem(reply.reason); return; }
    notices?.push("success", words.removedTitle(reply.color, article), words.removedMessage(reply.removed));
    onClose();
    onRemoved(reply.color);
  };

  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>{words.cancel}</button>
      <button type="button" className="btn btn-danger" disabled={!chosen || busy} onClick={() => void remove()}>
        {busy ? words.removing : chosen ? words.confirm(chosen) : words.confirm("colour")}
      </button>
    </>
  );

  return (
    <Modal title={words.title(article)} subtitle={words.subtitle} onClose={onClose} footer={footer}>
      <div className="rc-colours" role="radiogroup" aria-label={words.pick}>
        {colours.map((colour) => (
          <button key={colour} type="button" role="radio" aria-checked={colour === chosen} className={colour === chosen ? "rc-colour is-on" : "rc-colour"}
            onClick={() => { setChosen(colour); setProblem(null); }}>
            <ColorSwatch color={colour} /><span className="rc-colour-name">{colour}</span>
            {colorToUrdu(colour, dictionary) ? <span className="urdu-text rc-colour-urdu" lang="ur" dir="rtl">{colorToUrdu(colour, dictionary)}</span> : null}
          </button>
        ))}
      </div>
      <p className="rc-explain">{chosen ? words.explain(article, chosen) : words.choose}</p>
      <p className="field-help">{words.rule}</p>
      {problem ? <p className="error-message" role="alert">⚠ {problem}</p> : null}
    </Modal>
  );
};

export const RemoveColorControl: React.FC<RemoveColorControlProps> = (props) => {
  const [open, setOpen] = useState(false);
  if (props.colours.length === 0) return null;
  return (
    <>
      <button type="button" className="btn btn-ghost sa-add-color rc-open" aria-label={words.buttonLabel(props.article)} title={words.buttonLabel(props.article)}
        onClick={() => setOpen(true)}>
        {words.button}
      </button>
      {open ? <RemoveColorDialog {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
};
