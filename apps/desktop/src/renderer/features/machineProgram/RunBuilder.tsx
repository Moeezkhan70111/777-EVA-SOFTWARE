import React, { useEffect, useRef, useState } from "react";
import { copy } from "../../config/copy";
import { DanaPanel } from "./DanaPanel";
import { ArticleStep, ColourStep, SizeStep } from "./RunSteps";
import { RUN_STEPS, firstOpenStep, type RunDraft, type RunStep } from "./machineProgram";

// One sole run, asked one question at a time:
//
//   SOLE COLOUR (and the Dana for it) → ARTICLE → SIZE → (what the caller asks next)
//
// What has been answered stays on screen as a trail above the question, each answer with its own
// Change, and ← Back steps to the previous question. Nothing answered is ever lost by going back;
// only a different ARTICLE clears the size, because sizes belong to an article.
//
// `asks` is which of the three questions this builder owns. Adding an article inside a sole
// colour's card owns only the article and the size: the colour is that card's, so it is shown in
// the trail as settled and can be neither walked back into nor changed from here — otherwise an
// article added under BLACK could quietly save itself under RED.
//
// When every question it owns is answered the builder shows `complete` — the upper picker for a
// new run, the save panel when a saved run is being changed.

interface RunBuilderProps {
  initialDraft: RunDraft;
  /** The questions this builder asks, in order. Defaults to all three. */
  asks?: readonly RunStep[];
  /** What comes after the questions. */
  complete: (draft: RunDraft, back: () => void) => React.ReactNode;
  /** ← Back from the first question. */
  onExit: () => void;
}

const QUESTION: Record<RunStep, string> = {
  colour: copy.machineProgram.stepSoleColour,
  article: copy.machineProgram.stepArticle,
  size: copy.machineProgram.stepSize,
};

export const RunBuilder: React.FC<RunBuilderProps> = ({ initialDraft, asks = RUN_STEPS, complete, onExit }) => {
  const [draft, setDraft] = useState<RunDraft>(initialDraft);
  const [step, setStep] = useState<RunStep | null>(firstOpenStep(initialDraft));

  const question = useRef<HTMLDivElement>(null);

  // Each new question is brought into view with the answers above it, so answering one never
  // leaves the next off screen.
  useEffect(() => {
    question.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [step]);

  const answer = (patch: Partial<RunDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setStep(firstOpenStep(next));
  };

  const back = () => {
    const index = step ? asks.indexOf(step) : asks.length;
    if (index <= 0) onExit();
    else setStep(asks[index - 1]);
  };

  return (
    <div ref={question} className="mp-builder">
      <RunTrail draft={draft} current={step} asks={asks} onChange={setStep} />

      {step ? (
        <section className="mp-panel">
          <div className="mp-step-head">
            {/* Nothing to step back to on the first question — the dialog's own Cancel leaves. */}
            {asks.indexOf(step) > 0 ? (
              <button type="button" className="btn btn-ghost mp-back-step" onClick={back}>
                {copy.machineProgram.back}
              </button>
            ) : null}
            <h3 className="mp-question">{QUESTION[step]}</h3>
          </div>
          {step === "colour" ? <ColourStep selected={draft.soleColour} onChoose={(soleColour) => answer({ soleColour })} /> : null}
          {step === "article" ? (
            <ArticleStep
              selected={draft.article}
              onChoose={(article) => answer(article === draft.article ? {} : { article, articleSizeId: null, size: null })}
            />
          ) : null}
          {step === "size" && draft.article ? (
            <SizeStep article={draft.article} selectedId={draft.articleSizeId} onChoose={(size) => answer(size)} />
          ) : null}
        </section>
      ) : (
        complete(draft, back)
      )}

      {/* The Dana is shown as soon as the sole colour is known, and stays in view — except where
          the colour is settled elsewhere, which is where the Dana is already on screen. */}
      {draft.soleColour && step !== "colour" && asks.includes("colour") ? <DanaPanel colour={draft.soleColour} /> : null}
    </div>
  );
};

/** The answers so far. Only the questions this builder asks carry a Change. */
const RunTrail: React.FC<{
  draft: RunDraft;
  current: RunStep | null;
  asks: readonly RunStep[];
  onChange: (step: RunStep) => void;
}> = ({ draft, current, asks, onChange }) => {
  const items: Array<{ step: RunStep; label: string; value: string | null }> = [
    { step: "colour", label: copy.machineProgram.soleColour, value: draft.soleColour },
    { step: "article", label: copy.machineProgram.article, value: draft.article },
    { step: "size", label: copy.machineProgram.size, value: draft.size },
  ];
  return (
    <ol className="mp-trail">
      {items.map((item) => (
        <li key={item.step} className={`mp-trail-item${item.value ? " is-done" : ""}${item.step === current ? " is-current" : ""}`}>
          <span className="mp-trail-label">{item.label}</span>
          <span className="mp-trail-value">{item.value ? `✓ ${item.value}` : "—"}</span>
          {item.value && item.step !== current && asks.includes(item.step) ? (
            <button type="button" className="mp-trail-change" onClick={() => onChange(item.step)} aria-label={`${copy.machineProgram.change} ${item.label}`}>
              {copy.machineProgram.change}
            </button>
          ) : null}
        </li>
      ))}
    </ol>
  );
};
