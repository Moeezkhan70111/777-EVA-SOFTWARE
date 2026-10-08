import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProductFormPage } from "./ProductFormPage";
import { NotificationsProvider } from "../state/NotificationsContext";

function setupDesktop(api: Record<string, unknown>) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
}

describe("ProductFormPage article image handling", () => {
  it("loads the article image by article name and overwrites it when a new image is uploaded", async () => {
    const getProductImage = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
    const saveProductImage = vi.fn().mockResolvedValue({ accepted: true, fileName: "SK6.png" });

    setupDesktop({
      listUniqueArticles: vi.fn().mockResolvedValue(["SK6"]),
      listUniqueSizesByArticle: vi.fn().mockResolvedValue(["7/10", "8/10"]),
      listMainGroups: vi.fn().mockResolvedValue([]),
      listProductGroups: vi.fn().mockResolvedValue([]),
      listArticleSeries: vi.fn().mockResolvedValue([]),
      getNextProductCode: vi.fn().mockResolvedValue("P-0001"),
      getProductImage,
      saveProductImage,
      createProduct: vi.fn().mockResolvedValue("new-product"),
      updateProduct: vi.fn().mockResolvedValue(undefined),
    });

    render(
      <NotificationsProvider>
        <ProductFormPage onNavigate={() => undefined} />
      </NotificationsProvider>
    );

    const articleInput = screen.getByLabelText(/product name \/ article/i);
    await userEvent.clear(articleInput);
    await userEvent.type(articleInput, "SK6");

    await waitFor(() => expect(getProductImage).toHaveBeenCalledWith("SK6"));
    await waitFor(() =>
      expect(screen.getByAltText(/sk6 product image/i)).toHaveAttribute("src", "data:image/png;base64,AAAA")
    );

    const file = new File(["fakepng"], "sample.jpg", { type: "image/jpeg" });
    const uploadInput = document.getElementById("productImageInput") as HTMLInputElement;
    fireEvent.change(uploadInput, { target: { files: [file] } });

    await waitFor(() =>
      expect(saveProductImage).toHaveBeenCalledWith("SK6", expect.stringContaining("data:image/png;base64,"))
    );
  });
});

describe("ProductFormPage uppercase inputs", () => {
  function renderForm() {
    setupDesktop({
      listUniqueArticles: vi.fn().mockResolvedValue([]),
      listUniqueSizesByArticle: vi.fn().mockResolvedValue([]),
      listMainGroups: vi.fn().mockResolvedValue([]),
      listProductGroups: vi.fn().mockResolvedValue([]),
      listArticleSeries: vi.fn().mockResolvedValue([]),
      getNextProductCode: vi.fn().mockResolvedValue("P-0001"),
      getProductImage: vi.fn().mockResolvedValue(null),
    });
    render(
      <NotificationsProvider>
        <ProductFormPage onNavigate={() => undefined} />
      </NotificationsProvider>
    );
  }

  it("uppercases whatever is typed into the article and classification fields", async () => {
    renderForm();

    const article = screen.getByLabelText(/product name \/ article/i);
    await userEvent.type(article, "sk6 abc");
    expect(article).toHaveValue("SK6 ABC");

    const mainGroup = screen.getByLabelText(/^main group$/i);
    await userEvent.type(mainGroup, "gents");
    expect(mainGroup).toHaveValue("GENTS");

    const productGroup = screen.getByLabelText(/^product group$/i);
    await userEvent.type(productGroup, "eva");
    expect(productGroup).toHaveValue("EVA");

    const series = screen.getByLabelText(/^article series$/i);
    await userEvent.type(series, "classic");
    expect(series).toHaveValue("CLASSIC");
  });

  it("uppercases whatever is typed into the add-new dialogs", async () => {
    renderForm();

    await userEvent.click(screen.getByTitle("Add new article"));
    const newArticle = screen.getByLabelText(/^article name/i);
    await userEvent.type(newArticle, "sk6");
    expect(newArticle).toHaveValue("SK6");
    await userEvent.keyboard("{Escape}");

    await userEvent.click(screen.getByTitle("Add new main group"));
    const newMainGroup = screen.getByLabelText(/^group name/i);
    await userEvent.type(newMainGroup, "ladies");
    expect(newMainGroup).toHaveValue("LADIES");
  });
});
