import React from "react";
import type { CartonSeriesOption, CartonStockHeld } from "@erp/domain";
import { SearchableCombobox, type SearchableComboboxOption } from "../../components/shared/SearchableCombobox";
import { copy } from "../../config/copy";
import { NAV_ICONS } from "../navigation/NavIcons";
import { dozenFigure } from "./CartonMatrix";

// The Carton Stock page's article series picker: the shared searchable picker (R1), opening as a
// panel with its own search. Every series says how many articles it has and what they hold in
// dozens, and "All Article Series" says the same for the whole store. The figures are the main
// process's (buildCartonStockMatrix); this only words them.

const text = copy.cartonStock;

const optionFor = (value: string, label: string, held: CartonStockHeld): SearchableComboboxOption => ({
  value,
  label,
  detail: text.seriesArticles(held.articles),
  badge: text.seriesDozens(dozenFigure(held.cartons)),
});

interface SeriesPickerProps {
  value: string;
  options: readonly CartonSeriesOption[];
  allSeries: CartonStockHeld;
  onChange: (value: string) => void;
}

export const SeriesPicker: React.FC<SeriesPickerProps> = ({ value, options, allSeries, onChange }) => (
  <div className="cs-series">
    <SearchableCombobox
      ariaLabel={text.seriesLabel}
      placeholder={text.allSeries}
      searchPlaceholder={text.seriesSearch}
      emptyLabel={text.seriesNone}
      icon={NAV_ICONS.stock}
      value={value}
      options={[optionFor("", text.allSeries, allSeries), ...options.map((option) => optionFor(option.series, option.series, option))]}
      onChange={onChange}
    />
  </div>
);
