import React, { useEffect, useMemo, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { copy } from "../../config/copy";
import type { RawMaterialSetupTemplate } from "../../types/desktopApi";
import { Modal } from "./Modal";
import { AddUnitModal } from "./AddUnitModal";
import { AttributeField } from "./AttributeField";
import { UrduInput } from "../../components/shared/UrduInput";
import { colorValueInUrdu, learnColorUrdu } from "../../utils/urdu";
import {
  categoryPath,
  identityFields,
  isColorFieldLabel,
  setupTemplateLabel,
  descendantsOf,
  materialCategoryId,
  topCategories,
  type CategoryRow,
} from "./rawMaterial";

// Creating a raw material. This was a whole page ("Add Raw Material") that could only
// create — it had no list and no edit — so it is now the "+ New Material" action on the list
// it was always missing.
//
// The business rules are unchanged and still belong to the data layer: the item's identity is
// a signature over its attribute values, so creating one that already exists returns the
// existing item rather than a duplicate, and that is reported as such.
//
// A material joins a sub-category already set up. DANA — EVA — BLACK, RED and BLUE are one
// material in three colours: the same unit, the same bag, the same machine. So the sub-category
// is asked what its materials are, and the new one starts there rather than being configured
// by hand a fourth time and drifting. What it inherits is stated on screen before saving,
// because inheriting silently would mean finding out where it goes when the first packet is issued.

interface NewMaterialModalProps {
  categories: CategoryRow[];
  units: Array<Record<string, unknown>>;
  onClose: () => void;
  /** Called after a successful create so the caller can refresh its list. */
  onCreated: () => Promise<void> | void;
  /** Re-reads categories and units after an option or unit is added mid-form. */
  onLookupsChanged: () => Promise<void>;
  /**
   * "modal" (default) is the Stock tab's dialog. "page" renders the same form inline, for the
   * full-screen Store Move In flow — one form, two shells, so there is still one implementation.
   */
  layout?: "modal" | "page";
}

export const NewMaterialModal: React.FC<NewMaterialModalProps> = ({
  categories,
  units,
  onClose,
  onCreated,
  onLookupsChanged,
  layout = "modal",
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [categoryId, setCategoryId] = useState("");
  const [subCategoryId, setSubCategoryId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [openingStock, setOpeningStock] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  // The Colour attribute's Urdu translation, keyed the same as `values`. Auto-filled from the
  // English value until the operator types into it directly — the automatic dictionary is
  // sometimes wrong for a particular shade, and this is the escape hatch for that, not a
  // second source of truth: an untouched field is left out of what gets saved (see `create`),
  // so materialLabelAttributes keeps recomputing it dynamically for every material nobody had
  // to correct by hand.
  const [valuesUrdu, setValuesUrdu] = useState<Record<string, string>>({});
  const [urduEditedFields, setUrduEditedFields] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const [template, setTemplate] = useState<RawMaterialSetupTemplate | null>(null);

  const [optionField, setOptionField] = useState<Record<string, unknown> | null>(null);
  const [optionValue, setOptionValue] = useState("");
  const [savingOption, setSavingOption] = useState(false);
  const [addingUnit, setAddingUnit] = useState(false);

  // A material can be filed on the category itself or on any kind of it, however deep. So
  // every descendant is offered, by its full path, and picking none files it right here.
  const subCategories = useMemo(() => descendantsOf(categories, categoryId), [categories, categoryId]);
  const hasSubCategories = subCategories.length > 0;
  const leafId = materialCategoryId(categoryId, subCategoryId);
  const categoryName = String(categories.find((row) => String(row.id) === categoryId)?.name ?? "it");
  const category = categories.find((row) => String(row.id) === leafId);
  const fields = useMemo(() => identityFields(category), [category]);

  const previewName = useMemo(() => {
    if (!category) return "";
    const parts = fields
      .map((field) => values[String(field.field_key)])
      .filter((value) => value && value.trim() !== "");
    return [categoryPath(category), ...parts].join(" — ");
  }, [category, fields, values]);

  // What this sub-category is already set up as. Read whenever the chosen category changes;
  // a late answer for a category the operator has since moved off is dropped.
  useEffect(() => {
    if (!leafId) {
      setTemplate(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const found = await api.getRawMaterialSetupTemplate(leafId);
      if (cancelled) return;
      setTemplate(found);
      // The unit is prefilled rather than forced: it is the one part of the setup the operator
      // may legitimately differ on, and it stays a normal select.
      if (found?.unitId) setUnitId((current) => current || found.unitId!);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, leafId]);

  const setValue = (fieldKey: string, value: string) => {
    setValues((current) => ({ ...current, [fieldKey]: value }));
    const field = fields.find((candidate) => String(candidate.field_key) === fieldKey);
    if (field && isColorFieldLabel(String(field.label)) && !urduEditedFields.has(fieldKey)) {
      setValuesUrdu((current) => ({ ...current, [fieldKey]: colorValueInUrdu(value) }));
    }
  };

  const setValueUrdu = (fieldKey: string, value: string) => {
    setUrduEditedFields((current) => new Set(current).add(fieldKey));
    setValuesUrdu((current) => ({ ...current, [fieldKey]: value }));
  };

  const resetValues = () => {
    setValues({});
    setValuesUrdu({});
    setUrduEditedFields(new Set());
  };

  const selectCategory = (nextId: string) => {
    setCategoryId(nextId);
    setSubCategoryId("");
    resetValues();
    setUnitId("");
  };

  const create = async () => {
    if (!leafId) return;
    const missing = fields.find(
      (field) => field.is_required && !(values[String(field.field_key)] ?? "").trim()
    );
    if (missing) {
      push("error", "Something is missing", `Enter ${String(missing.label)} before saving.`);
      return;
    }

    // Only a colour the operator actually corrected by hand is saved as an override — one
    // nobody touched is left out, so it keeps translating dynamically at print time. The
    // correction is also learned (see colorValueInUrdu), so the NEXT material in this colour
    // gets it as the default instead of repeating whatever was wrong before.
    const editedValuesUrdu: Record<string, string> = {};
    for (const fieldKey of urduEditedFields) {
      const urdu = valuesUrdu[fieldKey]?.trim();
      if (!urdu) continue;
      editedValuesUrdu[fieldKey] = urdu;
      learnColorUrdu(values[fieldKey] ?? "", urdu);
    }

    setCreating(true);
    try {
      const result = await api.createInventoryItem({
        categoryId: leafId,
        values,
        valuesUrdu: Object.keys(editedValuesUrdu).length > 0 ? editedValuesUrdu : undefined,
        unitId: unitId || undefined,
        stockQuantity: openingStock.trim() === "" ? undefined : Number(openingStock),
        costPrice: costPrice.trim() === "" ? undefined : Number(costPrice),
        // The route travels with the material, applied by the data layer inside the same
        // transaction that creates it. What a packet holds is not part of a material: it is
        // typed for each label run. The container's name still follows the sub-category.
        packName: template?.packName ?? undefined,
      });
      if (!result.accepted) {
        push("error", "Material not created", result.reason ?? "The material could not be saved.");
        return;
      }
      if (result.duplicate) {
        push("info", "This material already exists", `${result.code} · ${result.displayName}`);
      } else {
        push("success", "Material created", `${result.code} · ${result.displayName}`);
      }
      await onCreated();
      onClose();
    } finally {
      setCreating(false);
    }
  };

  const saveOption = async () => {
    if (!optionField || !optionValue.trim()) return;
    setSavingOption(true);
    try {
      const value = optionValue.trim().toUpperCase();
      const result = await api.addInventoryFieldOption({ fieldId: String(optionField.id), value });
      if (!result.accepted) {
        push("error", "Option not added", result.reason ?? "The option could not be saved.");
        return;
      }
      await onLookupsChanged();
      setValue(String(optionField.field_key), value);
      push("success", "Option added", `${value} · ${String(optionField.label)}`);
      setOptionField(null);
      setOptionValue("");
    } finally {
      setSavingOption(false);
    }
  };

  const createButton = (
    <button type="button" className="btn btn-primary" disabled={creating || !leafId} onClick={() => void create()}>
      {creating ? "Saving…" : "Create material"}
    </button>
  );

  const body = (
    <>
        <div className="rm-form-grid">
          <div className="form-group">
            <label className="input-label" htmlFor="rm-new-category">
              Category<span className="required-mark"> *</span>
            </label>
            <select
              id="rm-new-category"
              className="form-input"
              value={categoryId}
              onChange={(event) => selectCategory(event.target.value)}
            >
              <option value="">Select a category…</option>
              {topCategories(categories).map((row) => (
                <option key={String(row.id)} value={String(row.id)}>
                  {String(row.name)}
                </option>
              ))}
            </select>
            {categories.length === 0 ? (
              <span className="field-help">No categories yet — add one on the Setup tab first.</span>
            ) : null}
          </div>

          {hasSubCategories ? (
            <div className="form-group">
              <label className="input-label" htmlFor="rm-new-subcategory">
                Sub-category
              </label>
              <select
                id="rm-new-subcategory"
                className="form-input"
                value={subCategoryId}
                onChange={(event) => {
                  setSubCategoryId(event.target.value);
                  resetValues();
                }}
              >
                <option value="">{`File it directly under ${categoryName}`}</option>
                {subCategories.map((row) => (
                  <option key={String(row.id)} value={String(row.id)}>
                    {categoryPath(row)}
                  </option>
                ))}
              </select>
              <span className="field-help">Pick which kind this material is, or leave it on the category itself.</span>
            </div>
          ) : null}

          <div className="form-group">
            <label className="input-label" htmlFor="rm-new-unit">
              Stock unit
            </label>
            <div className="input-with-button">
              <select
                id="rm-new-unit"
                className="form-input"
                value={unitId}
                onChange={(event) => setUnitId(event.target.value)}
              >
                <option value="">Select a unit…</option>
                {units.map((unit) => (
                  <option key={String(unit.id)} value={String(unit.id)}>
                    {String(unit.name)} ({String(unit.code)})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-icon"
                title="Add a new unit"
                aria-label="Add a new unit"
                onClick={() => setAddingUnit(true)}
              >
                +
              </button>
            </div>
            <span className="field-help">
              {template?.unitCode
                ? `Taken from the rest of this sub-category (${template.unitCode}). Change it only if this material is counted differently.`
                : "Needed before any opening stock can be recorded."}
            </span>
          </div>

          <div className="form-group">
            <label className="input-label" htmlFor="rm-new-opening">
              Opening stock
            </label>
            <input
              id="rm-new-opening"
              className="form-input"
              type="number"
              step="any"
              value={openingStock}
              placeholder="Optional"
              onChange={(event) => setOpeningStock(event.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="input-label" htmlFor="rm-new-cost">
              Cost price (Rs.)
            </label>
            <input
              id="rm-new-cost"
              className="form-input"
              type="number"
              step="any"
              value={costPrice}
              placeholder="Optional"
              onChange={(event) => setCostPrice(event.target.value)}
            />
          </div>
        </div>

        {leafId && template ? (
          <p className="rm-preview">
            <span className="rm-preview-label">Will follow {template.sourceDisplayName}</span>
            {setupTemplateLabel(template)}
          </p>
        ) : null}

        {leafId && !template ? (
          <p className="field-help">
            Nothing in this sub-category has a route yet. Set it on this material once it is saved, and every
            material added to the sub-category after it will follow.
          </p>
        ) : null}

        {leafId && fields.length === 0 ? (
          <p className="field-help">This category has no attributes set up, so every item in it would be the same material.</p>
        ) : null}

        {fields.length > 0 ? (
          <div className="rm-form-grid">
            {fields.map((field) => {
              const fieldKey = String(field.field_key);
              const isColor = isColorFieldLabel(String(field.label));
              return (
                <React.Fragment key={String(field.id)}>
                  <AttributeField
                    field={field}
                    mode="create"
                    value={values[fieldKey] ?? ""}
                    onChange={setValue}
                    onAddOption={(target) => {
                      setOptionField(target);
                      setOptionValue("");
                    }}
                  />
                  {isColor ? (
                    <div className="form-group">
                      <label className="input-label" htmlFor={`rm-new-${fieldKey}-urdu`}>
                        {String(field.label)} (Urdu)
                      </label>
                      <UrduInput
                        id={`rm-new-${fieldKey}-urdu`}
                        value={valuesUrdu[fieldKey] ?? ""}
                        onChange={(value) => setValueUrdu(fieldKey, value)}
                        placeholder="اردو میں رنگ"
                      />
                      <span className="field-help">Auto-translated. Edit this if it looks wrong.</span>
                    </div>
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        ) : null}

        {optionField ? (
          <div className="rm-inline-add">
            <label className="input-label" htmlFor="rm-new-option">
              New {String(optionField.label)}
            </label>
            <input
              id="rm-new-option"
              className="form-input"
              autoFocus
              value={optionValue}
              onChange={(event) => setOptionValue(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveOption();
                }
              }}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={savingOption || !optionValue.trim()}
              onClick={() => void saveOption()}
            >
              {savingOption ? "Saving…" : copy.actions.add}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOptionField(null)}>
              {copy.common.cancel}
            </button>
          </div>
        ) : null}

        {previewName ? (
          <p className="rm-preview">
            <span className="rm-preview-label">Will be saved as</span>
            {previewName}
          </p>
        ) : null}
    </>
  );

  return (
    <>
      {layout === "page" ? (
        <section className="rm-new-page" aria-label="New raw material">
          {body}
          <div className="rm-new-page-actions">{createButton}</div>
        </section>
      ) : (
        <Modal
          title="New raw material"
          subtitle="Pick a category, fill in what tells this material apart, and save."
          wide
          onClose={onClose}
          footer={createButton}
        >
          {body}
        </Modal>
      )}

      {addingUnit ? (
        <AddUnitModal
          onClose={() => setAddingUnit(false)}
          onCreated={async (newUnitId) => {
            await onLookupsChanged();
            if (newUnitId) setUnitId(newUnitId);
          }}
        />
      ) : null}
    </>
  );
};
