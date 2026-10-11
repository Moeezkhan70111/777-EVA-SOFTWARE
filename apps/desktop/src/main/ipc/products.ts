// Product master, product lists (dropdown values), images and the rate list export.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { BrowserWindow, dialog } from "electron";
import { PERMISSION, PRODUCT_STATUS, optionalOneOf } from "@erp/domain";
import type { ProductListKind } from "@erp/data";
import fs from "node:fs";
import path from "node:path";

const RATE_KEYS = ["machineRate", "packingRate", "printingRate"] as const;

/**
 * The product's standard contractor rates, as the form sent them: rupees per DOZEN, or null.
 *
 * An empty box is **null — not set** — and not 0 (migration 064): a product nobody has priced is
 * reported as unpriced on a machine program, while a typed 0 means that job is not paid for this
 * article. A value that is not a finite number is therefore null too, never silently zero.
 *
 * A caller that sends NONE of the three keys gets `{}` back, which the data layer reads as "leave
 * the rates alone". That is what keeps the older simple product form (ProductsPage), which knows
 * nothing about contractor pricing, from blanking rates somebody set on the full form.
 */
const contractorRates = (
  input?: Record<string, unknown>
): { machineRate?: number | null; packingRate?: number | null; printingRate?: number | null } => {
  if (!RATE_KEYS.some((key) => input != null && key in input)) return {};
  const rate = (value: unknown): number | null => (Number.isFinite(value) ? Number(value) : null);
  return {
    machineRate: rate(input?.machineRate),
    packingRate: rate(input?.packingRate),
    printingRate: rate(input?.printingRate),
  };
};

export function registerProductsHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, deviceId, paths, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  ipcMain.handle(IPC.listProducts, (_event, query?: Record<string, unknown>) => {
    return db.listProducts({
      search: typeof query?.search === "string" ? query.search : "",
      status:
        query?.status === "ACTIVE" || query?.status === "DISABLED" || query?.status === "ALL"
          ? query.status
          : "ALL",
      page: Number.isFinite(query?.page) ? Number(query?.page) : 1,
      pageSize: Number.isFinite(query?.pageSize) ? Number(query?.pageSize) : 20,
    });
  });

  ipcMain.handle(IPC.getProduct, (_event, id: string) => {
    return db.getProduct(id);
  });

  ipcMain.handle(IPC.getSaleableVariant, (_event, id: string) => {
    return db.getSaleableVariant(id);
  });

  const PRODUCT_LIST_KINDS: readonly ProductListKind[] = ["article", "size", "main-group", "product-group", "article-series"];

  const productListKind = (value: unknown): ProductListKind => {
    const kind = optionalOneOf(value, PRODUCT_LIST_KINDS);
    if (!kind) throw new Error("Unknown product list.");
    return kind;
  };

  const productImagePath = (article: string) => {
    const safeName = article.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
    return safeName ? path.join(paths.productImagesDir, `${safeName}.png`) : null;
  };

  ipcMain.handle(IPC.listProductListEntries, (_event, kind?: string) => db.listProductListEntries(productListKind(kind)));

  ipcMain.handle(IPC.renameProductListEntry, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
      const kind = productListKind(input?.kind);
      const id = String(input?.id ?? "");
      const result = db.renameProductListEntry({ kind, id, newName: String(input?.newName ?? "") });
      // The article's image is stored under its name, so it follows the rename.
      if (kind === "article" && result.affected > 0) {
        const from = productImagePath(id);
        const to = productImagePath(result.name);
        if (from && to && from !== to && fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
      }
      logger.log({ module: "product-lists", severity: "INFO", operation: "rename", deviceId, message: `${kind} ${id} → ${result.name}` });
      return { accepted: true, ...result };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not rename" };
    }
  });

  ipcMain.handle(IPC.deleteProductListEntry, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
      const kind = productListKind(input?.kind);
      const result = db.deleteProductListEntry({
        kind,
        id: String(input?.id ?? ""),
        actor: typeof input?.actor === "string" ? input.actor : null,
        reason: typeof input?.reason === "string" ? input.reason : undefined,
      });
      logger.log({ module: "product-lists", severity: "WARNING", operation: "delete", deviceId, message: `${kind} ${String(input?.id ?? "")}` });
      return { accepted: true, ...result };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not delete" };
    }
  });

  ipcMain.handle(IPC.createProduct, (event, input?: Record<string, unknown>) => {
    authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
    return db.createProduct({
      article: String(input?.article ?? "").trim(),
      color: typeof input?.color === "string" ? input.color.trim() : undefined,
      size: String(input?.size ?? "").trim(),
      description: typeof input?.description === "string" ? input.description : undefined,
      costPrice: Number.isFinite(input?.costPrice) ? Number(input?.costPrice) : undefined,
      sellingPrice: Number.isFinite(input?.sellingPrice) ? Number(input?.sellingPrice) : undefined,
      ...contractorRates(input),
      mainGroupId: typeof input?.mainGroupId === "string" && input.mainGroupId ? input.mainGroupId : undefined,
      productGroupId: typeof input?.productGroupId === "string" && input.productGroupId ? input.productGroupId : undefined,
      articleSeriesId: typeof input?.articleSeriesId === "string" && input.articleSeriesId ? input.articleSeriesId : undefined,
      productTypeId: typeof input?.productTypeId === "string" && input.productTypeId ? input.productTypeId : undefined,
      productSubGroupId: typeof input?.productSubGroupId === "string" && input.productSubGroupId ? input.productSubGroupId : undefined,
      colors: Array.isArray(input?.colors) ? input.colors.filter((value): value is string => typeof value === "string") : undefined,
      productCode: typeof input?.productCode === "string" && input.productCode ? input.productCode : undefined,
      status: PRODUCT_STATUS.ACTIVE
    });
  });

  ipcMain.handle(IPC.updateProduct, (event, id: string, input?: Record<string, unknown>) => {
    authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
    const previous = db.getProduct(id);
    const nextSellingPrice = Number.isFinite(input?.sellingPrice) ? Number(input?.sellingPrice) : null;
    if (previous?.article && previous.size && previous.sellingPrice !== nextSellingPrice) {
      const settings = db.getSettings();
      let previousRates: Record<string, number | null> = {};
      try {
        const saved = JSON.parse(settings["rate-list.previous-rates"] ?? "{}");
        if (saved && typeof saved === "object") previousRates = saved as Record<string, number | null>;
      } catch {
        previousRates = {};
      }
      previousRates[`A_TYPE:${previous.article}:${previous.size}`] = previous.sellingPrice ?? null;
      db.setSettings({ ...settings, "rate-list.previous-rates": JSON.stringify(previousRates) }, "desktop-ui");
    }
    db.updateProduct(id, {
      article: String(input?.article ?? "").trim(),
      color: typeof input?.color === "string" ? input.color.trim() : undefined,
      size: String(input?.size ?? "").trim(),
      description: typeof input?.description === "string" ? input.description : undefined,
      costPrice: Number.isFinite(input?.costPrice) ? Number(input?.costPrice) : undefined,
      sellingPrice: Number.isFinite(input?.sellingPrice) ? Number(input?.sellingPrice) : undefined,
      ...contractorRates(input),
      mainGroupId: typeof input?.mainGroupId === "string" && input.mainGroupId ? input.mainGroupId : undefined,
      productGroupId: typeof input?.productGroupId === "string" && input.productGroupId ? input.productGroupId : undefined,
      articleSeriesId: typeof input?.articleSeriesId === "string" && input.articleSeriesId ? input.articleSeriesId : undefined,
      productTypeId: typeof input?.productTypeId === "string" && input.productTypeId ? input.productTypeId : undefined,
      productSubGroupId: typeof input?.productSubGroupId === "string" && input.productSubGroupId ? input.productSubGroupId : undefined,
      colors: Array.isArray(input?.colors) ? input.colors.filter((value): value is string => typeof value === "string") : undefined,
      status: PRODUCT_STATUS.ACTIVE
    });
  });

  ipcMain.handle(IPC.disableProduct, (event, id: string) => {
    authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
    db.disableProduct(id);
  });

  ipcMain.handle(IPC.enableProduct, (event, id: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
      db.enableProduct(id);
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to enable product" };
    }
  });

  ipcMain.handle(IPC.getProductImage, (_event, article?: string) => {
    const name = String(article ?? "").trim();
    if (!name) return null;

    const safeName = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
    if (!safeName) return null;

    const imagePath = path.join(paths.productImagesDir, `${safeName}.png`);
    if (!fs.existsSync(imagePath)) return null;

    const fileBuffer = fs.readFileSync(imagePath);
    return `data:image/png;base64,${fileBuffer.toString("base64")}`;
  });

  ipcMain.handle(IPC.saveProductImage, (event, article?: string, dataUrl?: string) => {
    authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
    const articleName = String(article ?? "").trim();
    if (!articleName) {
      return { accepted: false, reason: "Article name is required" };
    }
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
      return { accepted: false, reason: "Valid image data is required" };
    }

    const safeName = articleName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
    if (!safeName) {
      return { accepted: false, reason: "Article name is invalid" };
    }

    const [, encoded] = dataUrl.split(",");
    const buffer = Buffer.from(encoded ?? "", "base64");
    const targetPath = path.join(paths.productImagesDir, `${safeName}.png`);
    fs.writeFileSync(targetPath, buffer);
    return { accepted: true, fileName: `${safeName}.png` };
  });

  ipcMain.handle(IPC.saveRateList, async (event, payload?: { html?: string; fileName?: string }) => {
    authorizer.requireUser(event);
    if (!payload?.html) return { accepted: false, reason: "Rate list content is required" };
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const saveOptions = {
      defaultPath: payload.fileName || "rate-list.pdf",
      filters: [{ name: "PDF document", extensions: ["pdf"] }],
    };
    const result = parent
      ? await dialog.showSaveDialog(parent, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (result.canceled || !result.filePath) return { accepted: false, canceled: true };

    const tempHtmlPath = path.join(paths.scratchDir, `rate-list-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      // Chromium rejects large percent-encoded data URLs; a temporary local file keeps images and CSS intact.
      fs.writeFileSync(tempHtmlPath, payload.html, "utf8");
      await printWindow.loadFile(tempHtmlPath);
      const pdf = await printWindow.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
      let savedPath = result.filePath;
      try {
        fs.writeFileSync(savedPath, pdf);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (!(["EBUSY", "EPERM", "EACCES"] as string[]).includes(code ?? "")) throw error;

        const parsedPath = path.parse(result.filePath);
        let suffix = 1;
        do {
          savedPath = path.join(parsedPath.dir, `${parsedPath.name} (${suffix})${parsedPath.ext}`);
          suffix += 1;
        } while (fs.existsSync(savedPath));
        fs.writeFileSync(savedPath, pdf);
      }
      return { accepted: true, filePath: savedPath };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not generate PDF" };
    } finally {
      if (!printWindow.isDestroyed()) printWindow.destroy();
      try { fs.unlinkSync(tempHtmlPath); } catch { /* already removed */ }
    }
  });

  ipcMain.handle(IPC.listProductGroups, () => {
    try {
      return db.listProductGroups();
    } catch (error) {
      logger.log({
        module: "product",
        severity: "ERROR",
        operation: "list-groups",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list product groups",
      });
      return [];
    }
  });

  ipcMain.handle(IPC.createProductGroup, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
      const groupName = typeof input?.groupName === "string" ? input.groupName.trim() : "";
      if (!groupName) {
        return { accepted: false, reason: "Group name is required" };
      }

      const existing = db.getProductGroupByName(groupName);
      if (existing) {
        return { accepted: false, reason: "Group with this name already exists" };
      }

      const groupId = db.createProductGroup({
        groupName,
        description: typeof input?.description === "string" ? input.description : undefined,
      });

      logger.log({
        module: "product",
        severity: "INFO",
        operation: "create-group",
        deviceId,
        message: `Product group created: ${groupName}`,
      });

      return { accepted: true, groupId };
    } catch (error) {
      logger.log({
        module: "product",
        severity: "ERROR",
        operation: "create-group",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to create product group",
      });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to create group" };
    }
  });

  ipcMain.handle(IPC.listArticleSeries, () => {
    try {
      return db.listArticleSeries();
    } catch (error) {
      logger.log({
        module: "product",
        severity: "ERROR",
        operation: "list-article-series",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list article series",
      });
      return [];
    }
  });

  ipcMain.handle(IPC.createArticleSeries, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!name) return { accepted: false, reason: "Series name is required" };

      const existing = db.getArticleSeriesByName(name);
      if (existing) return { accepted: false, reason: "Series with this name already exists", id: existing.id };

      const id = db.createArticleSeries({ name, description: typeof input?.description === "string" ? input.description : undefined });
      logger.log({ module: "product", severity: "INFO", operation: "create-article-series", deviceId, message: `Article series created: ${name}` });
      return { accepted: true, id };
    } catch (error) {
      logger.log({ module: "product", severity: "ERROR", operation: "create-article-series", deviceId, message: error instanceof Error ? error.message : "Failed to create article series" });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to create article series" };
    }
  });

  // ─── Product type and product sub group (migration 066) ───────────────────
  // A TYPE is a flat list. A SUB GROUP belongs to a product group, so listing one takes the
  // group the form has chosen and creating one takes the group it goes under.

  ipcMain.handle(IPC.listProductTypes, () => {
    try {
      return db.listProductTypes();
    } catch (error) {
      logger.log({
        module: "product", severity: "ERROR", operation: "list-product-types", deviceId,
        message: error instanceof Error ? error.message : "Failed to list product types",
      });
      return [];
    }
  });

  ipcMain.handle(IPC.createProductType, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!name) return { accepted: false, reason: "Product type name is required" };
      const id = db.createProductType({ name, description: typeof input?.description === "string" ? input.description : null });
      logger.log({ module: "product", severity: "INFO", operation: "create-product-type", deviceId, message: `Product type created: ${name}` });
      return { accepted: true, id };
    } catch (error) {
      logger.log({ module: "product", severity: "ERROR", operation: "create-product-type", deviceId, message: error instanceof Error ? error.message : "Failed to create product type" });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to create product type" };
    }
  });

  ipcMain.handle(IPC.listProductSubGroups, (_event, productGroupId?: string) => {
    try {
      return db.listProductSubGroups(typeof productGroupId === "string" ? productGroupId : null);
    } catch (error) {
      logger.log({
        module: "product", severity: "ERROR", operation: "list-product-sub-groups", deviceId,
        message: error instanceof Error ? error.message : "Failed to list product sub groups",
      });
      return [];
    }
  });

  ipcMain.handle(IPC.createProductSubGroup, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      const productGroupId = typeof input?.productGroupId === "string" ? input.productGroupId.trim() : "";
      if (!name) return { accepted: false, reason: "Product sub group name is required" };
      // The parent is the whole point of a SUB group, so it is refused here as well as below.
      if (!productGroupId) return { accepted: false, reason: "Choose the product group this sub group belongs to" };
      const id = db.createProductSubGroup({
        productGroupId,
        name,
        description: typeof input?.description === "string" ? input.description : null,
        hasNoUpper: input?.hasNoUpper === true,
      });
      logger.log({ module: "product", severity: "INFO", operation: "create-product-sub-group", deviceId, message: `Product sub group created: ${name}` });
      return { accepted: true, id };
    } catch (error) {
      logger.log({ module: "product", severity: "ERROR", operation: "create-product-sub-group", deviceId, message: error instanceof Error ? error.message : "Failed to create product sub group" });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to create product sub group" };
    }
  });

  ipcMain.handle(IPC.setProductSubGroupHasNoUpper, (event, id?: string, hasNoUpper?: boolean) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
      db.setProductSubGroupHasNoUpper(String(id ?? ""), hasNoUpper === true);
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not change this sub group" };
    }
  });

  ipcMain.handle(IPC.listMainGroups, () => {
    try {
      return db.listMainGroups();
    } catch (error) {
      logger.log({
        module: "product",
        severity: "ERROR",
        operation: "list-main-groups",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list main groups",
      });
      return [];
    }
  });

  ipcMain.handle(IPC.createMainGroup, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PRODUCT_FORM);
      const groupName = typeof input?.groupName === "string" ? input.groupName.trim() : "";
      if (!groupName) {
        return { accepted: false, reason: "Group name is required" };
      }

      const existing = db.getMainGroupByName(groupName);
      if (existing) {
        return { accepted: false, reason: "Group with this name already exists" };
      }

      const groupId = db.createMainGroup({
        groupName,
        description: typeof input?.description === "string" ? input.description : undefined,
      });

      logger.log({
        module: "product",
        severity: "INFO",
        operation: "create-main-group",
        deviceId,
        message: `Main group created: ${groupName}`,
      });

      return { accepted: true, groupId };
    } catch (error) {
      logger.log({
        module: "product",
        severity: "ERROR",
        operation: "create-main-group",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to create main group",
      });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to create group" };
    }
  });

  ipcMain.handle(IPC.listUniqueArticles, () => {
    try {
      return db.listUniqueArticles();
    } catch (error) {
      logger.log({
        module: "product",
        severity: "ERROR",
        operation: "list-unique-articles",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list unique articles",
      });
      return [];
    }
  });

  ipcMain.handle(IPC.listUniqueSizesByArticle, (_event, article?: string) => {
    try {
      if (!article || typeof article !== "string") return [];
      return db.listUniqueSizesByArticle(article);
    } catch (error) {
      logger.log({
        module: "product",
        severity: "ERROR",
        operation: "list-unique-sizes",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list unique sizes",
      });
      return [];
    }
  });

  // Exposed in the preload and typed in DesktopApi, but previously had no handler.
  ipcMain.handle(IPC.listUniqueColorsByArticle, (_event, article?: string) => {
    try {
      if (!article || typeof article !== "string") return [];
      return db.listUniqueColorsByArticle(article);
    } catch (error) {
      logger.log({
        module: "product",
        severity: "ERROR",
        operation: "list-unique-colors",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list unique colors",
      });
      return [];
    }
  });
}
