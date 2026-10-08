import { describe, expect, it } from "vitest";
import { isColorFieldLabel, materialLabelAttributes, type InventoryItemRow } from "./rawMaterial";

const itemWith = (values: Array<Record<string, unknown>>): InventoryItemRow => ({ id: "item-1", values });

describe("materialLabelAttributes", () => {
  it("translates the Colour attribute to Urdu, however the category capitalised or spelled it, and flags it as the colour", () => {
    const item = itemWith([
      { label: "Colour", field_type: "DROPDOWN", text_value: "Black", number_value: null },
      { label: "COLOR", field_type: "TEXT", text_value: "Red", number_value: null },
    ]);
    expect(materialLabelAttributes(item)).toEqual([
      { label: "Colour", value: "سیاہ", isColor: true },
      { label: "COLOR", value: "لال", isColor: true },
    ]);
  });

  it("leaves every other attribute as typed, and not flagged as the colour", () => {
    const item = itemWith([
      { label: "Name", field_type: "TEXT", text_value: "SK6", number_value: null },
      { label: "Size", field_type: "TEXT", text_value: "7/10", number_value: null },
    ]);
    expect(materialLabelAttributes(item)).toEqual([
      { label: "Name", value: "SK6", isColor: false },
      { label: "Size", value: "7/10", isColor: false },
    ]);
  });

  it("drops the unit field and any attribute left blank", () => {
    const item = itemWith([
      { label: "Unit", field_type: "UNIT", text_value: "KG", number_value: null },
      { label: "Note", field_type: "TEXT", text_value: "", number_value: null },
      { label: "Weight", field_type: "NUMBER", text_value: null, number_value: 25 },
    ]);
    expect(materialLabelAttributes(item)).toEqual([{ label: "Weight", value: "25", isColor: false }]);
  });

  it("returns nothing for a material with no configured attributes", () => {
    expect(materialLabelAttributes(itemWith([]))).toEqual([]);
    expect(materialLabelAttributes({ id: "item-1" })).toEqual([]);
  });

  it("prefers a manual Urdu correction over the automatic translation", () => {
    const item = itemWith([{ label: "Colour", field_type: "TEXT", text_value: "Maroon", number_value: null, text_value_urdu: "گہرا لال" }]);
    expect(materialLabelAttributes(item)).toEqual([{ label: "Colour", value: "گہرا لال", isColor: true }]);
  });

  it("falls back to the automatic translation when no correction was entered", () => {
    const item = itemWith([{ label: "Colour", field_type: "TEXT", text_value: "Black", number_value: null, text_value_urdu: null }]);
    expect(materialLabelAttributes(item)).toEqual([{ label: "Colour", value: "سیاہ", isColor: true }]);
  });

  it("ignores a blank Urdu correction rather than printing nothing", () => {
    const item = itemWith([{ label: "Colour", field_type: "TEXT", text_value: "Black", number_value: null, text_value_urdu: "   " }]);
    expect(materialLabelAttributes(item)).toEqual([{ label: "Colour", value: "سیاہ", isColor: true }]);
  });
});

describe("isColorFieldLabel", () => {
  it("matches Colour and Color, in any casing, and nothing else", () => {
    expect(isColorFieldLabel("Colour")).toBe(true);
    expect(isColorFieldLabel("COLOR")).toBe(true);
    expect(isColorFieldLabel("  color  ")).toBe(true);
    expect(isColorFieldLabel("Shade")).toBe(false);
    expect(isColorFieldLabel("Size")).toBe(false);
  });
});
