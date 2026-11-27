import React, { useMemo, useRef, useState } from "react";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { SearchField } from "../../components/shared/SearchField";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { looseMatches } from "../customerLedger/looseSearch";
import { CustomerDiscountTable, type DiscountColumn } from "./CustomerDiscountTable";
import { DISCOUNT_KIND, SIZE_SCOPE, articleLabel, cellKey, currentDiscounts, discountChanges, type SizeScope } from "./discountPolicy";
import type { MatchedDiscount } from "./discountsFromList";
import { PasteDiscountsDialog } from "./PasteDiscountsDialog";
import type { DiscountPolicyData } from "./useDiscountPolicy";
import { useDiscountSave, type DiscountTarget } from "./useDiscountSave";

// SET DISCOUNTS on a product group, an article series or an article (owner, 28 Nov 2026, docs/56):
//
//   PRODUCT GROUP [ EVR GENTS ▾ ]        (Article: [ SK6 ▾ ]  SIZES [ All sizes | Each size ])
//   [ Search customers  / ]
//   Customer                        Discount / pair (Rs)
//   ABDUL GHANI HYDERABAD           [ 35 ]
//   BEHRAAM SHOES                   [ 40 ]  was 35
//                                         [Paste discounts]  [Save 1 change]
//
// The first product group or series is chosen to begin with (default effect), so the table is there at once. Each box
// starts with the discount now; Save names how many changes it sends and is off while there are none (Parkinson).

const text = copy.discountPolicy;
type EditKind = typeof DISCOUNT_KIND.PRODUCT_GROUP | typeof DISCOUNT_KIND.ARTICLE_SERIES | typeof DISCOUNT_KIND.ARTICLE;

interface SetDiscountsCardProps {
  kind: EditKind;
  data: DiscountPolicyData;
  canWrite: boolean;
  onSaved: () => void;
}

/** The picker's choices for this kind. */
const optionsOf = (kind: EditKind, data: DiscountPolicyData) =>
  kind === DISCOUNT_KIND.ARTICLE
    ? [...data.articles.keys()].map((article) => ({ value: article, label: article }))
    : (kind === DISCOUNT_KIND.PRODUCT_GROUP ? data.groups : data.series).map((option) => ({ value: option.id, label: option.name }));

/** The columns, and the report label each column's discount carries. */
const columnsOf = (kind: EditKind, name: string, sizes: readonly string[], scope: SizeScope): { columns: DiscountColumn[]; labels: Map<string, string> } => {
  if (kind === DISCOUNT_KIND.ARTICLE && scope === SIZE_SCOPE.SEPARATE_SIZES) {
    return { columns: sizes.map((size) => ({ size, label: text.sizeColumn(size) })), labels: new Map(sizes.map((size) => [size, articleLabel(name, size)])) };
  }
  return { columns: [{ size: "", label: text.discountColumn }], labels: new Map([["", kind === DISCOUNT_KIND.ARTICLE ? articleLabel(name, null) : name]]) };
};

export const SetDiscountsCard: React.FC<SetDiscountsCardProps> = ({ kind, data, canWrite, onSaved }) => {
  const options = useMemo(() => optionsOf(kind, data), [kind, data]);
  const [chosen, setChosen] = useState(kind === DISCOUNT_KIND.ARTICLE ? "" : (options[0]?.value ?? ""));
  const [scope, setScope] = useState<SizeScope>(SIZE_SCOPE.ALL_SIZES);
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pasting, setPasting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const partyName = (partyId: string) => data.customers.find((customer) => customer.id === partyId)?.partyName ?? partyId;
  const { saving, save } = useDiscountSave(partyName, onSaved);

  const name = options.find((option) => option.value === chosen)?.label ?? "";
  const sizes = data.articles.get(chosen);
  const { columns, labels } = useMemo(() => columnsOf(kind, name, sizes ?? [], scope), [kind, name, sizes, scope]);
  const current = useMemo(() => currentDiscounts(data.report, kind, labels), [data.report, kind, labels]);
  const { changes, problems } = discountChanges(drafts, current);
  const shown = data.customers.filter((customer) => looseMatches([customer.partyName, customer.partyNameUrdu ?? ""], search));
  const choose = (value: string) => { setChosen(value); setDrafts({}); };
  const target: DiscountTarget = kind === DISCOUNT_KIND.ARTICLE ? { kind, article: chosen, scope, name } : { kind, id: chosen, name };

  const submit = async () => {
    const saved = await save(target, changes);
    setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => !saved.has(key))));
  };
  const fillPasted = (matched: MatchedDiscount[]) => {
    setDrafts((previous) => ({ ...previous, ...Object.fromEntries(matched.map((row) => [cellKey(row.partyId), String(row.discountPerPair)])) }));
    setPasting(false);
  };

  const body = () => {
    if (!chosen) return <StateView kind="empty" compact title={text.chooseTitle[kind]} hint={text.chooseHint[kind]} />;
    if (data.customers.length === 0) return <StateView kind="empty" compact title={text.noCustomersTitle} hint={text.noCustomersHint} />;
    if (shown.length === 0) return <StateView kind="empty" compact title={text.noMatchTitle} hint={text.noMatchHint} />;
    return <CustomerDiscountTable customers={shown} columns={columns} current={current} drafts={drafts} problems={problems} what={name} disabled={!canWrite || saving}
      onType={(key, value) => setDrafts((previous) => ({ ...previous, [key]: value }))} />;
  };

  return (
    <>
      <div className="dp-pickers">
        <label className="dp-picker">
          <span className="input-label">{text.targets[kind]}</span>
          <SearchableCombobox ariaLabel={text.targets[kind]} placeholder={text.targetPlaceholders[kind]} searchPlaceholder={text.targetSearch} emptyLabel={text.noTargets}
            value={chosen} options={options} onChange={choose} />
        </label>
        {kind === DISCOUNT_KIND.ARTICLE ? (
          <div className="dp-picker">
            <span className="input-label" id="dp-scope-label">{text.sizesLabel}</span>
            <div className="sa-toggle" role="group" aria-labelledby="dp-scope-label">
              {Object.values(SIZE_SCOPE).map((value) => (
                <button key={value} type="button" className={scope === value ? "sa-toggle-btn is-on" : "sa-toggle-btn"} aria-pressed={scope === value}
                  onClick={() => { setScope(value); setDrafts({}); }}>{text.sizeScopes[value]}</button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {chosen ? <SearchField value={search} onChange={setSearch} label={text.searchLabel} placeholder={text.searchPlaceholder} clearLabel={text.searchClear} shortcutHint={text.searchShortcut} inputRef={searchRef} /> : null}
      {body()}
      {chosen ? (
        <div className="dp-actions">
          {problems.size > 0 ? <span className="dp-problem" role="status">⚠ {text.fixFirst(problems.size)}</span> : <span />}
          {columns.length === 1 ? <button type="button" className="btn btn-secondary" disabled={!canWrite || saving} onClick={() => setPasting(true)}>{copy.discountsFromList.open}</button> : null}
          <button type="button" className="btn btn-primary" disabled={!canWrite || saving || changes.length === 0 || problems.size > 0} onClick={() => void submit()}>
            {saving ? text.saving : text.save(changes.length)}
          </button>
        </div>
      ) : null}
      {pasting ? <PasteDiscountsDialog target={name} parties={data.customers} onClose={() => setPasting(false)} onFill={fillPasted} /> : null}
    </>
  );
};
