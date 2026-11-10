import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COLOR_TRANSLATION_ERROR, DEFAULT_COLOR_TRANSLATIONS, normalizeColorKey, type ColorTranslation } from "@erp/domain";
import { copy } from "../../config/copy";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { ColorTranslationPage } from "./ColorTranslationPage";
import { currentColorDictionary } from "./colorDictionaryStore";
import { LEGACY_COLOR_CORRECTIONS_KEY } from "./legacyColorCorrections";

// COLOR TRANSLATION: the shared English-to-Urdu colour list. The main process holds the list and its rules; this
// fake holds it the same way (one English key, one mapping) so the page is checked against the same answers.

const text = copy.colorTranslation;

let rows: ColorTranslation[] = [];
const duplicate = (englishName: string, exceptId: string | null) =>
  rows.some((row) => row.id !== exceptId && normalizeColorKey(row.englishName) === normalizeColorKey(englishName));

const api = {
  listColorTranslations: vi.fn(async () => ({ accepted: true, translations: rows })),
  createColorTranslation: vi.fn(async (input: { englishName: string; urduName: string }) => {
    if (duplicate(input.englishName, null)) return { accepted: false, reason: "refused", code: COLOR_TRANSLATION_ERROR.DUPLICATE_ENGLISH };
    rows = [...rows, { id: `new-${input.englishName}`, ...input }];
    return { accepted: true };
  }),
  updateColorTranslation: vi.fn(async (id: string, input: { englishName: string; urduName: string }) => {
    if (duplicate(input.englishName, id)) return { accepted: false, reason: "refused", code: COLOR_TRANSLATION_ERROR.DUPLICATE_ENGLISH };
    rows = rows.map((row) => (row.id === id ? { id, ...input } : row));
    return { accepted: true };
  }),
  deleteColorTranslation: vi.fn(async (id: string) => {
    rows = rows.filter((row) => row.id !== id);
    return { accepted: true };
  }),
};

const show = () => render(<NotificationsProvider><ColorTranslationPage /></NotificationsProvider>);
const table = () => within(screen.getByRole("table", { name: text.tableLabel }));
const englishColumn = () => table().getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0]?.textContent);

beforeEach(() => {
  window.localStorage.clear();
  rows = DEFAULT_COLOR_TRANSLATIONS.map((row) => ({ id: `color:${row.english.toLowerCase()}`, englishName: row.english, urduName: row.urdu }));
  for (const fn of Object.values(api)) fn.mockClear();
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

describe("the colour list", () => {
  it("shows every mapping with English, Urdu and actions, the owner's fifteen among them", async () => {
    show();
    await screen.findByRole("table", { name: text.tableLabel });
    expect(table().getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([text.english, text.urdu, text.actions]);
    expect(englishColumn()).toHaveLength(23);
    for (const urdu of ["سیاہ", "نیوی", "بلو", "پیلا", "نیون", "لال", "گرے", "اورنج", "کمانڈو", "آرمی گرین", "پنک", "کافی", "لایٹ", "ڈارک", "سفید"]) {
      expect(table().getAllByText(urdu).length).toBeGreaterThan(0);
    }
    expect(table().getByRole("button", { name: text.editLabel("Black") })).toBeInTheDocument();
  });

  it("searches by English in any case, and by Urdu", async () => {
    show();
    await screen.findByRole("table", { name: text.tableLabel });
    const search = screen.getByRole("searchbox", { name: text.searchLabel });
    await userEvent.type(search, "  ARMY ");
    await waitFor(() => expect(englishColumn().sort()).toEqual(["Army", "Army Green"]));
    await userEvent.clear(search);
    await userEvent.type(search, "گرے");
    await waitFor(() => expect(englishColumn().sort()).toEqual(["Gray", "Grey"]));
    await userEvent.clear(search);
    await userEvent.type(search, "zzz");
    expect(await screen.findByText(text.noMatchTitle)).toBeInTheDocument();
  });

  it("adds a colour, and the dictionary every screen reads has it at once", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: text.add }));
    await userEvent.type(screen.getByLabelText(text.english), "Purple");
    await userEvent.type(screen.getByLabelText(text.urdu), "پرپل");
    await userEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(englishColumn()).toContain("Purple"));
    expect(api.createColorTranslation).toHaveBeenCalledWith({ englishName: "Purple", urduName: "پرپل" });
    expect(currentColorDictionary().get("purple")).toBe("پرپل");
  });

  it("refuses a duplicate English colour with words that say what to do, and keeps the dialog open", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: text.add }));
    await userEvent.type(screen.getByLabelText(text.english), "black");
    await userEvent.type(screen.getByLabelText(text.urdu), "کالا");
    await userEvent.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text.errors.DUPLICATE_ENGLISH as string);
    expect(rows.filter((row) => row.englishName.toLowerCase() === "black")).toHaveLength(1);
  });

  it("checks an entry before sending it", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: text.add }));
    await userEvent.type(screen.getByLabelText(text.english), "Teal");
    await userEvent.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text.errors.URDU_REQUIRED as string);
    expect(api.createColorTranslation).not.toHaveBeenCalled();
  });

  it("edits a colour's Urdu, and deletes one only after confirming", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: text.editLabel("Black") }));
    const urdu = screen.getByLabelText(text.urdu);
    await userEvent.clear(urdu);
    await userEvent.type(urdu, "کالا");
    await userEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(table().getByText("کالا")).toBeInTheDocument());
    expect(currentColorDictionary().get("black")).toBe("کالا");

    await userEvent.click(table().getByRole("button", { name: text.deleteLabel("Sky") }));
    expect(api.deleteColorTranslation).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: text.deleteConfirm }));
    await waitFor(() => expect(englishColumn()).not.toContain("Sky"));
    expect(api.deleteColorTranslation).toHaveBeenCalledWith("color:sky");
  });

  it("shows a failed read with Retry, and an empty list with what to do", async () => {
    api.listColorTranslations.mockResolvedValueOnce({ accepted: false, reason: "SESSION_REQUIRED" } as never);
    show();
    expect(await screen.findByText("SESSION_REQUIRED")).toBeInTheDocument();
    rows = [];
    await userEvent.click(screen.getByRole("button", { name: copy.common.retry }));
    expect(await screen.findByText(text.emptyTitle)).toBeInTheDocument();
  });

  it("lists corrections this computer learned before the list, and adds or resolves them only when asked", async () => {
    window.localStorage.setItem(LEGACY_COLOR_CORRECTIONS_KEY, JSON.stringify({ maroon: "مہرون", black: "کالا", red: "لال" }));
    show();
    const learned = within(await screen.findByRole("region", { name: text.learnedTitle }));
    expect(learned.getAllByRole("listitem")).toHaveLength(2);
    expect(api.createColorTranslation).not.toHaveBeenCalled();
    await userEvent.click(learned.getByRole("button", { name: text.learnedAdd }));
    await waitFor(() => expect(englishColumn()).toContain("MAROON"));
    await userEvent.click(within(screen.getByRole("region", { name: text.learnedTitle })).getByRole("button", { name: text.learnedUse }));
    await waitFor(() => expect(screen.queryByRole("region", { name: text.learnedTitle })).not.toBeInTheDocument());
    expect(rows.find((row) => row.englishName === "Black")?.urduName).toBe("کالا");
  });
});
