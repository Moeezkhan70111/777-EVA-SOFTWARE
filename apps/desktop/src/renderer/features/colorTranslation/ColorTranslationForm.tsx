import React, { useId, useState } from "react";
import { validateColorTranslation } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { UrduInput } from "../../components/shared/UrduInput";
import { copy } from "../../config/copy";
import type { ColorWriteReply } from "./colorTranslationReply";

// Adding or editing one colour. The rule is @erp/domain's (validateColorTranslation), checked here so the person
// is told before saving and again by the data layer, which also refuses a duplicate English colour.

const text = copy.colorTranslation;

/** A refusal in words: the code's sentence, the main process's own words, or the generic one. */
export const colorRefusalText = (reply: Extract<ColorWriteReply, { ok: false }>): string =>
  (reply.code ? text.errors[reply.code] : undefined) ?? reply.reason ?? text.notSaved;

interface ColorTranslationFormProps {
  /** Absent for a new colour. */
  initial?: { englishName: string; urduName: string };
  onSave: (englishName: string, urduName: string) => Promise<ColorWriteReply>;
  onClose: () => void;
}

export const ColorTranslationForm: React.FC<ColorTranslationFormProps> = ({ initial, onSave, onClose }) => {
  const englishId = useId();
  const urduId = useId();
  const problemId = useId();
  const [english, setEnglish] = useState(initial?.englishName ?? "");
  const [urdu, setUrdu] = useState(initial?.urduName ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const invalid = validateColorTranslation(english, urdu);
    if (invalid !== null) {
      setProblem(text.errors[invalid] ?? text.notSaved);
      return;
    }
    setSaving(true);
    try {
      const reply = await onSave(english, urdu);
      if (reply.ok) onClose();
      else setProblem(colorRefusalText(reply));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={initial ? text.editTitle : text.addTitle}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? copy.common.saving : text.save}
        </button>
      }
    >
      <form
        className="ct-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="form-group">
          <label className="input-label" htmlFor={englishId}>{text.english}</label>
          <input
            id={englishId}
            className="form-input"
            value={english}
            autoFocus
            aria-describedby={problem ? problemId : undefined}
            onChange={(event) => setEnglish(event.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="input-label" htmlFor={urduId}>{text.urdu}</label>
          <UrduInput id={urduId} value={urdu} onChange={setUrdu} />
        </div>
        {problem ? (
          <p id={problemId} className="confirm-problem" role="alert">⚠ {problem}</p>
        ) : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
};
