import React, { useEffect, useRef, useState } from "react";
import type { MachineShift } from "@erp/domain";
import type { MachineProgramArticleRate, MachineProgramRunRecord } from "../../types/desktopApi";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { Modal } from "../../components/shared/Modal";
import { StateView } from "../../components/shared/StateView";
import { StepHeading } from "../../components/shared/StepHeading";
import { copy } from "../../config/copy";
import { ChosenUppersTable } from "./ChosenUppersTable";
import { FixSolePanel } from "./FixSolePanel";
import { ContractorRateFields } from "./ContractorRateFields";
import { ArticleStep, ColourStep, SizeStep } from "./RunSteps";
import { UpperPicker } from "./UpperPicker";
import { isEmptyRateDraft } from "./ContractorRateFields";
import { danaLabel, fixQuantityProblem, runForArticleSize, type RunDraft } from "./machineProgram";
import { useChosenUppers } from "./useChosenUppers";
import { useArticles, useSoleColours } from "./useMachineProgramData";
import type { ProgramWrites } from "./useProgramWrites";

// + ADD SOLE COLOR / + ADD ARTICLE — one screen, three panels, and what has been chosen under
// them:
//
//   ① Sole Color      ② Article & Size       ③ Upper Stock          SK6 / 7/10
//   ● Black  120 Dzn   Article [ SK6    ▾ ]   ● Brown  10 Dzn  [+ Add]
//   ● Brown   80 Dzn   Size    [7/10][8/11]   ● Black  15 Dzn  [+ Add]
//   ┌ Selected Articles ─────────────────────────────────────────────────┐
//   │ SK6 · 7/10   ● Brown   10 DOZEN   [ 10 ]                        🗑 │
//   └────────────────────────────────── Cancel │ Add to Program ─────────┘
//
// Every question is on screen at once rather than one at a time, because the operator reads them
// together: which sole, and then what the store actually has for it. Choosing an upper does not
// save anything — it joins the selection, so several uppers (and several articles) go on in one
// go and the figures above stay where they were while that is being decided.
//
// A FIX article (EVR FIX: two soles, no upper) changes the screen the moment its size is chosen:
// the Upper Stock panel and the upper selection disappear, and the Sole Color panel asks for the
// outer sole, the inner sole (two dropdowns) and the quantity instead (FixSolePanel).
//
// `fixedColour` is the sole colour the dialog was opened under. Adding an article inside a sole
// colour's card cannot change it: otherwise an article added under BLACK could quietly save
// itself under RED.

interface AddArticleDialogProps {
  machineId: string;
  programDate: string;
  shift: MachineShift;
  injectorNo: number;
  /** The runs already in scope — a repeated article + size joins its run, never rivals it. */
  runs: MachineProgramRunRecord[];
  /** What the program already pays for each article, so the rate boxes open on that. */
  articleRates: MachineProgramArticleRate[];
  writes: ProgramWrites;
  onClose: () => void;
  /** Set when the card's own sole colour is the answer to the first panel. */
  fixedColour?: string;
  title: string;
  /** Where the uppers are going — the injector, or the sole card this was opened from. */
  where: string;
}

export const AddArticleDialog: React.FC<AddArticleDialogProps> = ({ fixedColour, title, where, onClose, ...target }) => {
  const [draft, setDraft] = useState<RunDraft>({
    soleColour: fixedColour ?? null,
    article: null,
    articleSizeId: null,
    size: null,
  });
  // The Product Master list the article panel is picked from. Read here too so the pricing boxes
  // can open on an article's STANDARD rates when the program has not priced it yet.
  const articles = useArticles();
  const chosen = useChosenUppers({ ...target, articles: articles.value });

  // A FIX article has no upper: the third panel asks for the inner sole and a quantity.
  // The flag rides on the article list, so it is known the moment a size is chosen.
  const [innerColour, setInnerColour] = useState<string | null>(null);
  const [fixQuantity, setFixQuantity] = useState("");
  const [fixSaving, setFixSaving] = useState(false);
  const [fixRefused, setFixRefused] = useState<string | null>(null);
<<<<<<< HEAD
  // Set once the fix run is on the program, so a pricing refusal can never lead to saving it twice.
  const [fixSaved, setFixSaved] = useState(false);
=======
>>>>>>> 3269f98a641b7a34ca7c94a185e4a1e67738de8f
  const chosenSize = articles.value
    .flatMap((entry) => entry.sizes)
    .find((size) => size.articleSizeId === draft.articleSizeId);
  const isFix = Boolean(chosenSize?.hasNoUpper);

  const describedRun =
    draft.soleColour && draft.article && draft.size && draft.articleSizeId
      ? { soleColour: draft.soleColour, article: draft.article, size: draft.size, articleSizeId: draft.articleSizeId }
      : null;

  // Uppers already on the run this article + size describes: adding one again would be the same
  // line, so the picker says so instead of offering it.
  const existing = describedRun ? runForArticleSize(target.runs, describedRun.soleColour, describedRun.articleSizeId) : null;
  const takenItemIds = new Set((existing?.lines ?? []).map((line) => line.itemId));

  const save = async () => {
    if (!isFix) {
      if (await chosen.addToProgram()) onClose();
      return;
    }
    if (!draft.soleColour || !innerColour || !draft.articleSizeId) return;
    setFixSaving(true);
    setFixRefused(null);
    try {
<<<<<<< HEAD
      const answer = await target.writes.saveFixRun({
=======
      const refusal = await target.writes.saveFixRun({
>>>>>>> 3269f98a641b7a34ca7c94a185e4a1e67738de8f
        machineId: target.machineId,
        programDate: target.programDate,
        shift: target.shift,
        injectorNo: target.injectorNo,
        soleColour: draft.soleColour,
        innerSoleColour: innerColour,
        articleSizeId: draft.articleSizeId,
        quantity: Number(fixQuantity),
      });
<<<<<<< HEAD
      if (!answer.ok) {
        setFixRefused(answer.reason);
        return;
      }
      // The run is on the program now. Its work is priced like any other article's; a pricing
      // refusal is said in place, and Add stays off so the run is never saved a second time.
      setFixSaved(true);
      const programId = answer.result.programId;
      const pricingRefused = programId ? await chosen.saveRates(programId, [draft.articleSizeId]) : null;
      if (pricingRefused) setFixRefused(pricingRefused);
=======
      if (refusal) setFixRefused(refusal);
>>>>>>> 3269f98a641b7a34ca7c94a185e4a1e67738de8f
      else onClose();
    } finally {
      setFixSaving(false);
    }
  };

<<<<<<< HEAD
  // Never the same colour twice: an outer and an inner sole of one colour is one sole, and the
  // floor would have nothing to tell them apart by — so it is said, not just refused.
  const sameSoles = Boolean(innerColour && innerColour === draft.soleColour);
  const fixProblem = fixQuantityProblem(fixQuantity) ?? (sameSoles ? copy.machineProgram.fixSameColour : null);
  // Both soles, a usable quantity, and rates that can be saved.
  const fixReady =
    Boolean(draft.soleColour && innerColour && draft.articleSizeId) &&
    !fixProblem &&
    fixQuantity.trim() !== "" &&
    chosen.rateProblem(draft.articleSizeId) === null;
=======
  const fixProblem = fixQuantityProblem(fixQuantity);
  // Both soles and a usable quantity, and never the same colour twice: an outer and an inner
  // sole of one colour is one sole, and the floor would have nothing to tell them apart by.
  const fixReady =
    Boolean(draft.soleColour && innerColour && draft.articleSizeId) &&
    innerColour !== draft.soleColour &&
    !fixProblem &&
    fixQuantity.trim() !== "";
>>>>>>> 3269f98a641b7a34ca7c94a185e4a1e67738de8f

  // On a short screen the selection sits below the panels. Choosing an upper brings it into
  // view, so the box its quantity goes in is never off the bottom of the dialog.
  const selection = useRef<HTMLElement>(null);
  const count = chosen.rows.length;
  useEffect(() => {
    if (count > 0) selection.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [count]);

  return (
    <Modal
      title={title}
      subtitle={copy.machineProgram.addArticleIntro(where)}
      wide="xl"
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary btn-lg"
<<<<<<< HEAD
          disabled={isFix ? !fixReady || fixSaving || fixSaved : !chosen.ready || chosen.saving}
=======
          disabled={isFix ? !fixReady || fixSaving : !chosen.ready || chosen.saving}
>>>>>>> 3269f98a641b7a34ca7c94a185e4a1e67738de8f
          onClick={() => void save()}
        >
          {(isFix ? fixSaving : chosen.saving) ? copy.machineProgram.addingToProgram : copy.machineProgram.addToProgram}
        </button>
      }
    >
      {/* A FIX article has no upper: the Upper Stock panel is not shown at all, and the Sole
          Color panel asks for both soles and the quantity instead. */}
      <div className={isFix ? "mpa-panels mpa-panels--two" : "mpa-panels"}>
        <section className="mpa-panel" aria-label={copy.machineProgram.panelSoleColour}>
          <div className="mpa-panel-head">
            <StepHeading
              index={1}
              done={isFix ? fixReady : Boolean(draft.soleColour)}
              title={copy.machineProgram.panelSoleColour}
            />
            {isFix && describedRun ? (
              <span className="mpa-for">
                {describedRun.article} / {describedRun.size}
              </span>
            ) : null}
          </div>
          <div className="mpa-panel-body">
            {isFix ? (
              <FixSolePanel
                outerColour={draft.soleColour}
                onChooseOuter={
                  fixedColour ? undefined : (soleColour) => setDraft((previous) => ({ ...previous, soleColour }))
                }
                fixedOuter={fixedColour ? <FixedColour colour={fixedColour} /> : undefined}
                innerColour={innerColour}
                onChooseInner={setInnerColour}
                quantity={fixQuantity}
                onQuantityChange={setFixQuantity}
                problem={fixProblem}
                disabled={fixSaving}
              />
            ) : fixedColour ? (
              <FixedColour colour={fixedColour} />
            ) : (
              <ColourStep
                layout="rows"
                selected={draft.soleColour}
                onChoose={(soleColour) => setDraft((previous) => ({ ...previous, soleColour }))}
              />
            )}
          </div>
        </section>

        <section className="mpa-panel" aria-label={copy.machineProgram.panelArticleSize}>
          <StepHeading index={2} done={Boolean(draft.articleSizeId)} title={copy.machineProgram.panelArticleSize} />
          <div className="mpa-panel-body">
            {draft.soleColour ? (
              <>
                <p className="mpa-field-label">{copy.machineProgram.article}</p>
                <ArticleStep
                  selected={draft.article}
                  onChoose={(article) =>
                    setDraft((previous) =>
                      article === previous.article ? previous : { ...previous, article, articleSizeId: null, size: null }
                    )
                  }
                />
                <p className="mpa-field-label">{copy.machineProgram.size}</p>
                {draft.article ? (
                  <SizeStep
                    layout="small"
                    article={draft.article}
                    selectedId={draft.articleSizeId}
                    onChoose={(size) => setDraft((previous) => ({ ...previous, ...size }))}
                  />
                ) : (
                  <StateView kind="empty" compact title={copy.machineProgram.chooseArticleFirst} />
                )}
              </>
            ) : (
              <StateView kind="empty" compact title={copy.machineProgram.chooseColourFirst} />
            )}
          </div>
        </section>

<<<<<<< HEAD
        {isFix ? null : (
          <section className="mpa-panel mpa-panel--stock" aria-label={copy.machineProgram.panelUpperStock}>
            <div className="mpa-panel-head">
              <StepHeading index={3} done={chosen.rows.length > 0} title={copy.machineProgram.panelUpperStock} />
              {describedRun ? (
                <span className="mpa-for">
                  {describedRun.article} / {describedRun.size}
                </span>
              ) : null}
            </div>
            <div className="mpa-panel-body">
              <UpperPicker
                machineId={target.machineId}
                articleSizeId={draft.articleSizeId}
                article={draft.article}
                size={draft.size}
                takenItemIds={takenItemIds}
                chosenItemIds={new Set(chosen.rows.map((row) => row.itemId))}
                stockVersion={target.writes.stockVersion}
                onAdd={(material) => {
                  if (describedRun) chosen.add(describedRun, material);
                }}
              />
            </div>
          </section>
        )}
=======
        <section
          className="mpa-panel mpa-panel--stock"
          aria-label={isFix ? copy.machineProgram.panelInnerSole : copy.machineProgram.panelUpperStock}
        >
          <div className="mpa-panel-head">
            <StepHeading
              index={3}
              done={isFix ? fixReady : chosen.rows.length > 0}
              title={isFix ? copy.machineProgram.panelInnerSole : copy.machineProgram.panelUpperStock}
            />
            {describedRun ? (
              <span className="mpa-for">
                {describedRun.article} / {describedRun.size}
              </span>
            ) : null}
          </div>
          <div className="mpa-panel-body">
            {isFix ? (
              <FixSolePanel
                outerColour={draft.soleColour}
                innerColour={innerColour}
                onChooseInner={setInnerColour}
                quantity={fixQuantity}
                onQuantityChange={setFixQuantity}
                problem={fixProblem}
                ready={Boolean(draft.articleSizeId)}
                disabled={fixSaving}
              />
            ) : (
            <UpperPicker
              machineId={target.machineId}
              articleSizeId={draft.articleSizeId}
              article={draft.article}
              size={draft.size}
              takenItemIds={takenItemIds}
              chosenItemIds={new Set(chosen.rows.map((row) => row.itemId))}
              stockVersion={target.writes.stockVersion}
              onAdd={(material) => {
                if (describedRun) chosen.add(describedRun, material);
              }}
            />
            )}
          </div>
        </section>
>>>>>>> 3269f98a641b7a34ca7c94a185e4a1e67738de8f
      </div>

      {fixRefused ? (
        <p className="mp-problem" role="alert">
          ⚠ {fixRefused}
        </p>
      ) : null}

      {/* ④ What the article's work is paid at. Beside the selection rather than in the panel row
          above: it is about the article, not about which upper is being fetched for it, and the
          three panels are already as narrow as they read well at. */}
      <section className="mpa-pricing" aria-label={copy.machineProgram.pricingPanel}>
        <div className="mpa-pricing-head">
          <StepHeading index={4} done={!isEmptyRateDraft(chosen.rateFor(draft.articleSizeId))} title={copy.machineProgram.pricingPanel} />
          {describedRun ? (
            <span className="mpa-for">{copy.machineProgram.pricingFor(describedRun.article, describedRun.size)}</span>
          ) : null}
        </div>
        {draft.articleSizeId ? (
          <>
            <p className="mp-note">{copy.machineProgram.pricingHint}</p>
            <ContractorRateFields
              idPrefix={`mpa-rate-${draft.articleSizeId}`}
              value={chosen.rateFor(draft.articleSizeId)}
              onChange={(next) => chosen.setRate(draft.articleSizeId as string, next)}
              disabled={chosen.saving}
            />
            {chosen.rateProblem(draft.articleSizeId) ? (
              <p className="mp-problem" role="alert">
                ⚠ {chosen.rateProblem(draft.articleSizeId)}
              </p>
            ) : null}
          </>
        ) : (
          <StateView kind="empty" compact title={copy.machineProgram.pricingChooseArticleFirst} />
        )}
      </section>

      {/* The chosen UPPERS. A fix article has none, so the list is not shown for it — unless
          uppers were picked for another article earlier in this dialog: those never vanish. */}
      {isFix && chosen.rows.length === 0 ? null : (
        <section ref={selection} className="mpa-chosen" aria-label={copy.machineProgram.selectedArticles}>
          <h3 className="mpa-chosen-title">{copy.machineProgram.selectedArticles}</h3>
          <ChosenUppersTable rows={chosen.rows} onSetQuantity={chosen.setQuantity} onRemove={chosen.remove} />
        </section>
      )}

      {chosen.problem ? (
        <p className="mp-problem" role="alert">
          ⚠ {chosen.problem} {copy.machineProgram.addRefusedPartly}
        </p>
      ) : null}
    </Modal>
  );
};

/**
 * The sole colour a card's + Add Article was opened under: shown as settled, never a choice,
 * with the Dana the store holds for it beside the name — the same line the colour list prints.
 */
const FixedColour: React.FC<{ colour: string }> = ({ colour }) => {
  const colours = useSoleColours();
  const dana = colours.value.find((option) => option.colour === colour);
  return (
    <>
      <p className="mpa-fixed">
        <ColorSwatch color={colour} className="mpa-swatch" />
        {copy.machineProgram.soleLine(colour)}
        {dana ? <span className="mpa-fixed-dana">{danaLabel(dana)}</span> : null}
      </p>
      <p className="mp-note">{copy.machineProgram.soleColourFixed}</p>
    </>
  );
};
