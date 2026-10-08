import React from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { ChoiceCards } from "./ChoiceCards";
import { formatAmount } from "./machineProgram";
import { useArticles, useSoleColours } from "./useMachineProgramData";

// The three card questions after the sole: its colour, the article, the size. Each is a plain
// ChoiceCards over data from its own master — the colours from the Dana in the store, the
// articles and sizes from the Product Master. Nothing here is a second list of anything.

const ARTICLE_SEARCH_FROM = 16;

export const ColourStep: React.FC<{ selected: string | null; onChoose: (colour: string) => void }> = ({ selected, onChoose }) => {
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
          sub: option.hasDana && option.danaQuantity != null ? `DANA ${formatAmount(option.danaQuantity, option.danaUnitCode)}` : undefined,
        }))}
        selectedKey={selected}
        onSelect={onChoose}
        empty={{ title: copy.machineProgram.noColoursTitle, hint: copy.machineProgram.noColoursHint }}
      />
    </>
  );
};

export const ArticleStep: React.FC<{ selected: string | null; onChoose: (article: string) => void }> = ({ selected, onChoose }) => {
  const articles = useArticles();
  if (articles.loading && articles.value.length === 0) return <StateView kind="loading" compact />;
  if (articles.error) return <StateView kind="error" compact message={articles.error} onRetry={() => void articles.reload()} />;

  return (
    <ChoiceCards
      choices={articles.value.map((entry) => ({ key: entry.article, title: entry.article }))}
      selectedKey={selected}
      onSelect={onChoose}
      searchLabel={copy.machineProgram.articleSearch}
      searchFrom={ARTICLE_SEARCH_FROM}
      noMatch={copy.machineProgram.articleNoMatch}
      empty={{ title: copy.machineProgram.noArticlesTitle, hint: copy.machineProgram.noArticlesHint }}
    />
  );
};

export const SizeStep: React.FC<{
  article: string;
  selectedId: string | null;
  onChoose: (size: { articleSizeId: string; size: string }) => void;
}> = ({ article, selectedId, onChoose }) => {
  const articles = useArticles();
  if (articles.loading && articles.value.length === 0) return <StateView kind="loading" compact />;
  if (articles.error) return <StateView kind="error" compact message={articles.error} onRetry={() => void articles.reload()} />;

  const sizes = articles.value.find((entry) => entry.article === article)?.sizes ?? [];
  return (
    <ChoiceCards
      choices={sizes.map((size) => ({ key: size.articleSizeId, title: size.size }))}
      selectedKey={selectedId}
      onSelect={(id) => {
        const size = sizes.find((candidate) => candidate.articleSizeId === id);
        if (size) onChoose(size);
      }}
      empty={{ title: copy.machineProgram.noArticlesTitle, hint: copy.machineProgram.noArticlesHint }}
    />
  );
};
