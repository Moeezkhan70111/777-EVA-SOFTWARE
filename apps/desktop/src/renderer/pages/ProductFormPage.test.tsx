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
      listProductTypes: vi.fn().mockResolvedValue([]),
      listProductSubGroups: vi.fn().mockResolvedValue([]),
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
      listProductTypes: vi.fn().mockResolvedValue([]),
      listProductSubGroups: vi.fn().mockResolvedValue([]),
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

// CONTRACTOR PRICING on a product — the standard rate its work is paid at, set here beside the
// sale price. An empty box is NOT SET, never 0: an unpriced product must not reach a machine
// program looking like free work.
describe("ProductFormPage contractor pricing", () => {
  const lookups = {
    listUniqueArticles: vi.fn().mockResolvedValue(["SK6"]),
    listUniqueSizesByArticle: vi.fn().mockResolvedValue(["7/10"]),
    listMainGroups: vi.fn().mockResolvedValue([]),
    listProductGroups: vi.fn().mockResolvedValue([]),
    listArticleSeries: vi.fn().mockResolvedValue([]),
      listProductTypes: vi.fn().mockResolvedValue([]),
      listProductSubGroups: vi.fn().mockResolvedValue([]),
    getNextProductCode: vi.fn().mockResolvedValue("P-0001"),
    getProductImage: vi.fn().mockResolvedValue(null),
  };

  const renderForm = (api: Record<string, unknown>, productId?: string) => {
    setupDesktop({ ...lookups, ...api });
    render(
      <NotificationsProvider>
        <ProductFormPage productId={productId} onNavigate={() => undefined} />
      </NotificationsProvider>
    );
  };

  const typeIn = async (label: RegExp, value: string) => {
    const box = screen.getByLabelText(label);
    await userEvent.clear(box);
    await userEvent.type(box, value);
  };

  /**
   * The article and size, the way the form takes them: both are select-only comboboxes, so each
   * is opened and PICKED from. Choosing the article is also what loads the sizes it is made in,
   * and the size box stays disabled until there is an article.
   */
  const describeProduct = async () => {
    await userEvent.click(screen.getByLabelText(/product name \/ article/i));
    await userEvent.click(await screen.findByRole("option", { name: "SK6" }));
    await userEvent.click(screen.getByLabelText(/^size/i));
    await userEvent.click(await screen.findByRole("option", { name: "7/10" }));
  };

  it("saves the three rates with the product, beside its prices", async () => {
    const createProduct = vi.fn().mockResolvedValue("new-product");
    renderForm({ createProduct, updateProduct: vi.fn() });

    await describeProduct();
    await typeIn(/sale price/i, "650");
    await typeIn(/machine rate/i, "45");
    await typeIn(/packing rate/i, "18");
    await typeIn(/printing rate/i, "12.5");

    await userEvent.click(screen.getByRole("button", { name: "Create Product" }));

    await waitFor(() =>
      expect(createProduct).toHaveBeenCalledWith(
        expect.objectContaining({ article: "SK6", machineRate: 45, packingRate: 18, printingRate: 12.5 })
      )
    );
  });

  it("sends an untouched rate as nothing, not as zero", async () => {
    const createProduct = vi.fn().mockResolvedValue("new-product");
    renderForm({ createProduct, updateProduct: vi.fn() });

    await describeProduct();
    await typeIn(/machine rate/i, "45");

    await userEvent.click(screen.getByRole("button", { name: "Create Product" }));

    await waitFor(() =>
      expect(createProduct).toHaveBeenCalledWith(
        expect.objectContaining({ machineRate: 45, packingRate: null, printingRate: null })
      )
    );
  });

  it("opens an existing product on the rates it is already priced at", async () => {
    renderForm(
      {
        getProduct: vi.fn().mockResolvedValue({
          id: "as-1",
          articleSizeId: "as-1",
          article: "SK6",
          color: "",
          size: "7/10",
          description: null,
          costPrice: 600,
          sellingPrice: 650,
          machineRatePaisa: 4500,
          packingRatePaisa: 1800,
          printingRatePaisa: 0,
          mainGroupId: null,
          groupId: null,
          status: "ACTIVE",
          createdAt: "",
          updatedAt: "",
        }),
        updateProduct: vi.fn(),
      },
      "as-1"
    );

    await waitFor(() => expect(screen.getByLabelText(/machine rate/i)).toHaveValue("45"));
    expect(screen.getByLabelText(/packing rate/i)).toHaveValue("18");
    // A stored zero is a real rate — "printing is not paid for this article" — and shows as 0.
    expect(screen.getByLabelText(/printing rate/i)).toHaveValue("0");
  });

  it("refuses a rate above what the books take, and does not save", async () => {
    const createProduct = vi.fn().mockResolvedValue("new-product");
    renderForm({ createProduct, updateProduct: vi.fn() });

    await describeProduct();
    await typeIn(/machine rate/i, "100001");

    await userEvent.click(screen.getByRole("button", { name: "Create Product" }));

    expect(await screen.findByText(/no more than Rs 100,000 per dozen/)).toBeInTheDocument();
    expect(createProduct).not.toHaveBeenCalled();
  });

  // The packing rate built from named attributes: BOX 50 + TAPE 30 + … = the packing rate.
  const addPackingAttribute = async (name: string, price: string) => {
    await userEvent.click(screen.getByRole("button", { name: "Add packing attribute" }));
    await userEvent.type(screen.getByLabelText(/name of attribute/i), name);
    await userEvent.type(screen.getByLabelText(/^price/i), price);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
  };

  it("adds packing attributes from the popup and makes the packing rate their sum", async () => {
    const createProduct = vi.fn().mockResolvedValue("new-product");
    renderForm({ createProduct, updateProduct: vi.fn() });

    await describeProduct();
    await addPackingAttribute("box", "50");
    await addPackingAttribute("TAPE", "30");
    await addPackingAttribute("POLY BAG", "50");
    await addPackingAttribute("LABOUR", "20");

    const packing = screen.getByLabelText(/packing rate/i);
    expect(packing).toHaveValue("150");
    expect(packing).toHaveAttribute("readonly");
    expect(screen.getByText("Total of 4 attributes")).toBeInTheDocument();
    expect(screen.getByText("BOX")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Create Product" }));

    await waitFor(() =>
      expect(createProduct).toHaveBeenCalledWith(
        expect.objectContaining({
          packingRate: 150,
          packingRateItems: [
            { name: "BOX", rate: 50 },
            { name: "TAPE", rate: 30 },
            { name: "POLY BAG", rate: 50 },
            { name: "LABOUR", rate: 20 },
          ],
        })
      )
    );
  });

  it("says what to fix in the popup instead of adding a nameless attribute", async () => {
    renderForm({ createProduct: vi.fn(), updateProduct: vi.fn() });

    await userEvent.click(screen.getByRole("button", { name: "Add packing attribute" }));
    await userEvent.type(screen.getByLabelText(/^price/i), "50");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/enter a name/i);
    expect(screen.getByLabelText(/packing rate/i)).not.toHaveAttribute("readonly");
  });

  it("opens a product on its packing attributes, and removing one lowers the rate", async () => {
    const updateProduct = vi.fn().mockResolvedValue(undefined);
    renderForm(
      {
        getProduct: vi.fn().mockResolvedValue({
          id: "as-1", articleSizeId: "as-1", article: "SK6", color: "", size: "7/10", description: null,
          costPrice: 600, sellingPrice: 650, machineRatePaisa: 4500, packingRatePaisa: 8000, printingRatePaisa: null,
          packingRateItems: [{ name: "BOX", ratePaisa: 5000 }, { name: "TAPE", ratePaisa: 3000 }],
          mainGroupId: null, groupId: null, status: "ACTIVE", createdAt: "", updatedAt: "",
        }),
        updateProduct,
      },
      "as-1"
    );

    await waitFor(() => expect(screen.getByLabelText(/packing rate/i)).toHaveValue("80"));
    await userEvent.click(screen.getByRole("button", { name: "Remove TAPE" }));
    expect(screen.getByLabelText(/packing rate/i)).toHaveValue("50");

    await userEvent.click(screen.getByRole("button", { name: "Update Product" }));
    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith(
        "as-1",
        expect.objectContaining({ packingRate: 50, packingRateItems: [{ name: "BOX", rate: 50 }] })
      )
    );
  });
});
