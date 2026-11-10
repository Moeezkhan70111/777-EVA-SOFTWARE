import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COLOR_TRANSLATIONS } from "@erp/domain";
import { NewMaterialModal } from "./NewMaterialModal";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { publishColorTranslations } from "../colorTranslation/colorDictionaryStore";
import { LEGACY_COLOR_CORRECTIONS_KEY } from "../colorTranslation/legacyColorCorrections";
import type { CategoryRow } from "./rawMaterial";

// ADD MATERIAL, AND ITS COLOUR. A colour is stored in English; the floor reads it in Urdu. Both directions go
// through the shared colour list (docs/45): English typed fills the Urdu, Urdu typed is read back to English, and
// Urdu the list cannot read back is refused rather than stored as if it were English.

const CATEGORIES: CategoryRow[] = [
  { id: "cat-dana", name: "DANA", parent_id: null, fields: [] },
  {
    id: "cat-eva",
    name: "EVA",
    parent_id: "cat-dana",
    fields: [{ id: "f-colour", field_key: "colour", label: "COLOUR", field_type: "TEXT", is_required: 1 }],
  },
];

const installApi = () => {
  const api = {
    getRawMaterialSetupTemplate: vi.fn(async () => null),
    createInventoryItem: vi.fn(async (_input: Record<string, unknown>) => ({ accepted: true, id: "i-1", code: "RM-1", displayName: "DANA — EVA" })),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
};

const show = () =>
  render(
    <NotificationsProvider>
      <NewMaterialModal categories={CATEGORIES} units={[{ id: "u-kg", code: "KG", name: "Kilogram" }]} onClose={vi.fn()} onCreated={vi.fn(async () => {})} onLookupsChanged={vi.fn(async () => {})} />
    </NotificationsProvider>
  );

const english = () => screen.getByLabelText(/COLOUR/, { selector: "input:not(.urdu-input)" }) as HTMLInputElement;
const urdu = () => screen.getByLabelText(/COLOUR \(Urdu\)/) as HTMLInputElement;

async function chooseEva() {
  await userEvent.selectOptions(screen.getByLabelText(/^Category/), "cat-dana");
  await userEvent.selectOptions(await screen.findByLabelText(/^Sub-category/), "cat-eva");
}

const saved = (api: ReturnType<typeof installApi>) => api.createInventoryItem.mock.calls[0]?.[0] as Record<string, unknown>;

beforeEach(() => {
  window.localStorage.clear();
  publishColorTranslations(DEFAULT_COLOR_TRANSLATIONS.map((row, index) => ({ id: `c-${String(index)}`, englishName: row.english, urduName: row.urdu })));
});

describe("a material's colour", () => {
  it("typed in English, shows its Urdu from the list and is saved in English with no override", async () => {
    const api = installApi();
    show();
    await chooseEva();
    await userEvent.type(english(), "army green");
    expect(urdu().value).toBe("آرمی گرین");
    await userEvent.click(screen.getByRole("button", { name: "Create material" }));
    await waitFor(() => expect(api.createInventoryItem).toHaveBeenCalled());
    expect(saved(api).values).toEqual({ colour: "ARMY GREEN" });
    expect(saved(api).valuesUrdu).toBeUndefined();
  });

  it("entered in Urdu, is read back to the list's English", async () => {
    const api = installApi();
    show();
    await chooseEva();
    await userEvent.click(english());
    await userEvent.paste("سیاہ");
    expect(english().value).toBe("BLACK");
    expect(urdu().value).toBe("سیاہ");
    await userEvent.click(screen.getByRole("button", { name: "Create material" }));
    await waitFor(() => expect(api.createInventoryItem).toHaveBeenCalled());
    expect(saved(api).values).toEqual({ colour: "BLACK" });
  });

  it("typed into the Urdu field first, fills in the English", async () => {
    installApi();
    show();
    await chooseEva();
    await userEvent.click(urdu());
    await userEvent.paste("پیلا");
    expect(english().value).toBe("YELLOW");
  });

  it("in Urdu the list cannot read back is refused, not saved as English", async () => {
    const api = installApi();
    show();
    await chooseEva();
    await userEvent.click(english());
    await userEvent.paste("نیلا");
    await userEvent.click(screen.getByRole("button", { name: "Create material" }));
    // Refused with a notice (copy.colorTranslation.urduNotInList); nothing is sent.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.createInventoryItem).not.toHaveBeenCalled();
    expect(english().value).toBe("نیلا");
  });

  it("corrected by hand, keeps the correction on the material and no longer teaches this computer alone", async () => {
    const api = installApi();
    show();
    await chooseEva();
    await userEvent.type(english(), "DARK CARAMEL");
    await userEvent.clear(urdu());
    await userEvent.click(urdu());
    await userEvent.paste("ڈارک کریمل");
    await userEvent.click(screen.getByRole("button", { name: "Create material" }));
    await waitFor(() => expect(api.createInventoryItem).toHaveBeenCalled());
    expect(saved(api).valuesUrdu).toEqual({ colour: "ڈارک کریمل" });
    expect(window.localStorage.getItem(LEGACY_COLOR_CORRECTIONS_KEY)).toBeNull();
  });
});
