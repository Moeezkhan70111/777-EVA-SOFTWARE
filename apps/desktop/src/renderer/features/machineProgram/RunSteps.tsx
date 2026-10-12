import React from "react";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { ChoiceCards } from "./ChoiceCards";
import { articlesOfKind, danaLabel, sizesOfKind, type ArticleKind } from "./machineProgram";
import { useArticles, useSoleColours } from "./useMachineProgramData";

// The three questions after the sole: its colour, the article, the size. The colour and the size
// are ChoiceCards over data from their own master — the colours from the Dana in the store, the
// sizes from the Product Master. Nothing here is a second list of anything.
//
// The article is the one question asked with a searchable dropdown rather than cards: the Product
// Master holds hundreds of them, and scanning a wall of identical tiles for "SK19" is work
// (R20). It is the shared SearchableCombobox in `dropdown` mode, so it looks and behaves like
// every other picker in the app (R1).

export const ColourStep: React.FC<{
  selected: string | null;
  onChoose: (colour: string) => void;
  /** `rows` stacks the colours with their Dana on the right, for a narrow panel. */
  layout?: "large" | "rows";
}> = ({ selected, onChoose, layout = "large" }) => {
  const colours = useSoleColours();
  if (colours.loading && colours.value.length === 0) return <StateView kind="loading" compact />;
  if (colours.error) return <StateView kind="error" compact message={colours.error} onRetry={() => void colours.reload()} />;

  const noDanaAtAll = colours.value.length > 0 && colours.value.every((option) => !option.hasDana);
  return (
    <>
      {noDanaAtAll ? <p className="mp-note">{copy.machineProgram.coloursWithoutDana}</p> : null}
      <ChoiceCards
        choices={colours.value.map((option) => ({
          key: option.colour,
          title: option.colour,
          swatch: option.colour,
          sub: danaLabel(option),
        }))}
        selectedKey={selected}
        onSelect={onChoose}
        size={layout}
        empty={{ title: copy.machineProgram.noColoursTitle, hint: copy.machineProgram.noColoursHint }}
      />
    </>
  );
};

export const ArticleStep: React.FC<{
  selected: string | null;
  onChoose: (article: string) => void;
  /** Only FIX articles (the Fix Articles section) or only those made with uppers (an injector). */
  kind?: ArticleKind;
}> = ({ selected, onChoose, kind }) => {
  const articles = useArticles();
  if (articles.loading && articles.value.length === 0) return <StateView kind="loading" compact />;
  if (articles.error) return <StateView kind="error" compact message={articles.error} onRetry={() => void articles.reload()} />;
  const offered = articlesOfKind(articles.value, kind);
  if (offered.length === 0) {
    return kind === "FIX" ? (
      <StateView kind="empty" compact title={copy.machineProgram.noFixArticlesTitle} hint={copy.machineProgram.noFixArticlesHint} />
    ) : (
      <StateView kind="empty" compact title={copy.machineProgram.noArticlesTitle} hint={copy.machineProgram.noArticlesHint} />
    );
  }

  return (
    <SearchableCombobox
      dropdown
      value={selected ?? ""}
      options={offered.map((entry) => ({ value: entry.article, label: entry.article }))}
      placeholder={copy.machineProgram.chooseArticle}
      ariaLabel={copy.machineProgram.article}
      emptyLabel={copy.machineProgram.articleNoMatch}
      onChange={onChoose}
    />
  );
};

export const SizeStep: React.FC<{
  article: string;
  selectedId: string | null;
  onChoose: (size: { articleSizeId: string; size: string }) => void;
  /** `small` packs the size tiles into the narrow Article & Size panel. */
  layout?: "large" | "small";
  /** Only the sizes of this kind — see ArticleStep. */
  kind?: ArticleKind;
}> = ({ article, selectedId, onChoose, layout = "large", kind }) => {
  const articles = useArticles();
  if (articles.loading && articles.value.length === 0) return <StateView kind="loading" compact />;
  if (articles.error) return <StateView kind="error" compact message={articles.error} onRetry={() => void articles.reload()} />;

  const sizes = sizesOfKind(articles.value.find((entry) => entry.article === article)?.sizes ?? [], kind);
  return (
    <ChoiceCards
      choices={sizes.map((size) => ({ key: size.articleSizeId, title: size.size }))}
      selectedKey={selectedId}
      onSelect={(id) => {
        const size = sizes.find((candidate) => candidate.articleSizeId === id);
        if (size) onChoose(size);
      }}
      size={layout}
      empty={{ title: copy.machineProgram.noArticlesTitle, hint: copy.machineProgram.noArticlesHint }}
    />
  );
};
