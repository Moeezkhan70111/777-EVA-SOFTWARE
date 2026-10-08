import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProductListsPage } from "./ProductListsPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import type { ProductListEntry } from "../types/desktopApi";

function setupDesktop(api: Record<string, unknown>) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
}

const entry = (overrides: Partial<ProductListEntry>): ProductListEntry => ({
  kind: "article",
  id: "SK16",
  name: "SK16",
  productCount: 2,
  disabledProductCount: 0,
  qrCount: 0,
  discountRuleCount: 0,
  renameBlockedReason: null,
  deleteBlockedReason: null,
  ...overrides,
});

const LISTS: Record<string, ProductListEntry[]> = {
  article: [
    entry({}),
    entry({
      id: "SK6",
      name: "SK6",
      productCount: 3,
      qrCount: 150,
      renameBlockedReason: "150 QR codes carry this article in its identity, so it cannot be changed. Create the correct product instead.",
      deleteBlockedReason: "150 QR codes carry this article in its identity, so it cannot be changed. Create the correct product instead.",
    }),
  ],
  size: [entry({ kind: "size", id: "7/10", name: "7/10", productCount: 5 })],
  "main-group": [
    entry({ kind: "main-group", id: "mg-1", name: "LADEIS", productCount: 0 }),
    entry({ kind: "main-group", id: "mg-2", name: "GENTS", productCount: 4, deleteBlockedReason: "Still used by 4 products. Move them to another main group first." }),
  ],
  "product-group": [],
  "article-series": [],
};

function baseApi(overrides: Record<string, unknown> = {}) {
  return {
    listProductListEntries: vi.fn().mockImplementation(async (kind: string) => LISTS[kind] ?? []),
    renameProductListEntry: vi.fn().mockResolvedValue({ accepted: true, affected: 3, name: "SK6" }),
    deleteProductListEntry: vi.fn().mockResolvedValue({ accepted: true, affected: 2 }),
    createMainGroup: vi.fn().mockResolvedValue({ accepted: true, groupId: "mg-3" }),
    createProductGroup: vi.fn().mockResolvedValue({ accepted: true, groupId: "pg-1" }),
    createArticleSeries: vi.fn().mockResolvedValue({ accepted: true, id: "s-1" }),
    ...overrides,
  };
}

const renderPage = () =>
  render(
    <NotificationsProvider>
      <ProductListsPage username="Moeezkhan123" />
    </NotificationsProvider>,
  );

const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
const findRow = async (name: string) => (await screen.findByText(name)).closest("tr") as HTMLElement;

describe("Fields Management", () => {
  it("lists each dropdown's values with usage, and locks the ones QR codes depend on", async () => {
    setupDesktop(baseApi());
    renderPage();

    expect(await screen.findByText("SK16")).toBeInTheDocument();
    expect(within(rowFor("SK16")).getByText("2 products")).toBeInTheDocument();
    expect(within(rowFor("SK16")).getByRole("button", { name: "Rename" })).toBeEnabled();
    expect(within(rowFor("SK16")).getByRole("button", { name: "Delete" })).toBeEnabled();

    // An article that real labels carry cannot be touched, and says why.
    const locked = rowFor("SK6");
    expect(within(locked).getByText("150 generated")).toBeInTheDocument();
    expect(within(locked).getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(within(locked).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(within(locked).getByText(/locked — QR codes exist/i)).toBeInTheDocument();

    // Tabs carry counts for every list.
    await waitFor(() => expect(screen.getByRole("button", { name: /Main Groups/ })).toHaveTextContent("2"));
  });

  it("renames a mistyped article (upper-cased) and reloads the list", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderPage();

    await userEvent.click(within(await findRow("SK16")).getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("New name for SK16");
    await userEvent.clear(input);
    await userEvent.type(input, "sk6{Enter}");

    await waitFor(() => expect(api.renameProductListEntry).toHaveBeenCalledWith({ kind: "article", id: "SK16", newName: "SK6" }));
    // Reloaded after the change (initial load + tab counts + reload).
    await waitFor(() => expect(api.listProductListEntries.mock.calls.filter((c: unknown[]) => c[0] === "article").length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByLabelText("New name for SK16")).not.toBeInTheDocument();
  });

  it("asks before removing, explains the effect, and records who did it", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderPage();

    await userEvent.click(within(await findRow("SK16")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: /remove article/i });
    expect(dialog).toHaveTextContent(/2 products carrying it will be disabled/i);
    await userEvent.click(within(dialog).getByRole("button", { name: "Disable products" }));

    await waitFor(() => expect(api.deleteProductListEntry).toHaveBeenCalledWith({ kind: "article", id: "SK16", actor: "Moeezkhan123" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("groups: unused ones can be deleted, used ones cannot, and new ones can be added here", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /Main Groups/ }));
    expect(await screen.findByText("LADEIS")).toBeInTheDocument();
    expect(within(rowFor("LADEIS")).getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(within(rowFor("GENTS")).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(within(rowFor("GENTS")).getByRole("button", { name: "Delete" })).toHaveAttribute("title", expect.stringMatching(/used by 4 products/));

    await userEvent.type(screen.getByLabelText("New main group"), "kids{Enter}");
    await waitFor(() => expect(api.createMainGroup).toHaveBeenCalledWith({ groupName: "KIDS" }));

    await userEvent.click(within(rowFor("LADEIS")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: /delete main group/i });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteProductListEntry).toHaveBeenCalledWith({ kind: "main-group", id: "mg-1", actor: "Moeezkhan123" }));
  });

  it("surfaces a refused rename without changing anything on screen", async () => {
    const api = baseApi({ renameProductListEntry: vi.fn().mockResolvedValue({ accepted: false, reason: "SK6 / 7/10 already exists." }) });
    setupDesktop(api);
    renderPage();

    await userEvent.click(within(await findRow("SK16")).getByRole("button", { name: "Rename" }));
    await userEvent.clear(screen.getByLabelText("New name for SK16"));
    await userEvent.type(screen.getByLabelText("New name for SK16"), "SK6{Enter}");
    await waitFor(() => expect(api.renameProductListEntry).toHaveBeenCalled());
    // Still editing; the row was not reloaded away (the reason goes to the notification centre).
    expect(screen.getByLabelText("New name for SK16")).toBeInTheDocument();
    expect(api.listProductListEntries.mock.calls.filter((c: unknown[]) => c[0] === "article")).toHaveLength(2); // initial + tab count only
  });
});
