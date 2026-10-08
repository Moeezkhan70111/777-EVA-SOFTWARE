// Raw material master: units, categories, attributes, items and stock movements.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION, asBoolean, asNumber, asOptionalNumber, asOptionalString, asRecord, asString, asStringRecord, isRecord, optionalOneOf } from "@erp/domain";
import { rejection } from "../authorize";

/** Absent → undefined (leave the pack alone), blank → null (clear it), otherwise the figure. */
function optionalPackingQuantity(setup: Record<string, unknown> | undefined): number | null | undefined {
  if (!setup || !("packingQuantity" in setup)) return undefined;
  const quantity = setup.packingQuantity;
  if (quantity == null || quantity === "") return null;
  return Number(quantity);
}

/**
 * Raw material setup (units, conversions, categories, attributes, options) is open to whoever
 * holds Settings, or the narrower Raw Material Setup permission — so a store operator can keep
 * the material catalogue in order without being handed the whole Settings area.
 */
const RAW_MATERIAL_SETUP_ACCESS = [PERMISSION.SETTINGS, PERMISSION.RAW_MATERIAL_SETUP] as const;

export function registerRawMaterialsHandlers(ctx: IpcContext): void {
  const { db, authorizer, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  // Category/unit/attribute setup is a Settings job; item stock movements are a Stock job.
  ipcMain.handle(IPC.listInventoryUnits, () => db.listInventoryUnits());

  // ─── Raw material Store movement configuration ────────────────────────────────
  ipcMain.handle(IPC.listWorkSections, () => db.listWorkSections());

  ipcMain.handle(IPC.createWorkSection, (_event, name?: string) => {
    try {
      return { accepted: true, section: db.createWorkSection({ name: String(name ?? "") }) };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "The section could not be saved." };
    }
  });

  ipcMain.handle(IPC.listRawMaterialMovementConfig, (_event, search?: string) =>
    db.listRawMaterialMovementConfig(typeof search === "string" ? search : "")
  );

  ipcMain.handle(IPC.setRawMaterialMovementConfig, (_event, itemId?: string, input?: Record<string, unknown>) => {
    try {
      const quantity = input?.packingQuantity;
      db.setRawMaterialMovementConfig(String(itemId ?? ""), {
        packingQuantity: quantity == null || quantity === "" ? null : Number(quantity),
        packingUnitId: input?.packingUnitId ? String(input.packingUnitId) : null,
        // Absent leaves the name alone; an empty string clears it back to the default.
        packName: "packName" in (input ?? {}) ? asOptionalString(input?.packName) ?? "" : undefined,
      });
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "The packing could not be saved." };
    }
  });

  // Every colour of DANA — EVA is the same material: same unit, same bag, same machine. So a
  // sub-category is asked what its materials are already set up as, and a new one starts there.
  ipcMain.handle(IPC.getRawMaterialSetupTemplate, (_event, categoryId?: string) =>
    db.rawMaterialSetupTemplate(String(categoryId ?? ""))
  );

  // Putting a whole sub-category back on one pack and one route. This writes to every material
  // in the category at once, so it is gated — the button only appears inside the Stock tab,
  // and hiding a button is not authorisation.
  ipcMain.handle(IPC.applyRawMaterialSetupToCategory, (event, categoryId?: string, setup?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      return {
        accepted: true,
        ...db.applyRawMaterialSetupToCategory(String(categoryId ?? ""), {
          packName: "packName" in (setup ?? {}) ? asOptionalString(setup?.packName) ?? "" : undefined,
          // Absent leaves the pack alone: it is entered per label run now, not per material.
          packingQuantity: optionalPackingQuantity(setup),
          packingUnitId: setup?.packingUnitId ? String(setup.packingUnitId) : null,
        }),
      };
    } catch (error) {
      return rejection(error, "The setup could not be applied to the sub-category");
    }
  });

  ipcMain.handle(IPC.createInventoryUnit, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      const id = db.createInventoryUnit({
        code: asString(input?.code),
        name: asString(input?.name),
        symbol: asOptionalString(input?.symbol),
        unitFamily: asOptionalString(input?.unitFamily),
        decimalScale: asNumber(input?.decimalScale),
      });
      return { accepted: true, id };
    } catch (error) {
      return rejection(error, "Could not create unit");
    }
  });

  ipcMain.handle(IPC.listInventoryUnitConversions, () => db.listInventoryUnitConversions());

  ipcMain.handle(IPC.createInventoryUnitConversion, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      const id = db.createInventoryUnitConversion({
        fromUnitId: asString(input?.fromUnitId),
        toUnitId: asString(input?.toUnitId),
        factor: asNumber(input?.factor),
      });
      return { accepted: true, id };
    } catch (error) {
      return rejection(error, "Could not create conversion");
    }
  });

  ipcMain.handle(IPC.listInventoryCategories, () => db.listInventoryCategories());

  ipcMain.handle(IPC.createInventoryCategory, (event, input?: Record<string, unknown>) => {
    try {
      const user = authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      const id = db.createInventoryCategory({
        name: asString(input?.name),
        description: asOptionalString(input?.description),
        // Set when the new category sits under an existing one.
        parentId: asOptionalString(input?.parentId) ?? null,
        packName: asOptionalString(input?.packName) ?? null,
        createdBy: asOptionalString(input?.createdBy) ?? user.username,
      });
      return { accepted: true, id };
    } catch (error) {
      return rejection(error, "Could not create category");
    }
  });

  ipcMain.handle(IPC.updateInventoryCategory, (event, categoryId: string, input?: Record<string, unknown>) => {
    try {
      const user = authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      db.updateInventoryCategory(asString(categoryId), {
        name: asOptionalString(input?.name),
        description: typeof input?.description === "string" ? input.description : undefined,
        // Absent keeps it, an empty string clears it (a sub-category then follows its parent).
        packName: typeof input?.packName === "string" ? input.packName : undefined,
        updatedBy: asOptionalString(input?.updatedBy) ?? user.username,
      });
      return { accepted: true };
    } catch (error) {
      return rejection(error, "Could not update category");
    }
  });

  ipcMain.handle(IPC.addInventoryCategoryField, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      const id = db.addInventoryCategoryField({
        categoryId: asString(input?.categoryId),
        fieldKey: asString(input?.fieldKey),
        label: asString(input?.label),
        fieldType: asString(input?.fieldType),
        required: asBoolean(input?.required),
        searchable: asBoolean(input?.searchable),
        sortOrder: asOptionalNumber(input?.sortOrder),
      });
      return { accepted: true, id };
    } catch (error) {
      return rejection(error, "Could not add attribute");
    }
  });

  ipcMain.handle(IPC.updateInventoryCategoryField, (event, fieldId: string, input?: Record<string, unknown>) => {
    try {
      const user = authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      db.updateInventoryCategoryField(asString(fieldId), {
        label: asOptionalString(input?.label),
        fieldType: asOptionalString(input?.fieldType),
        required: typeof input?.required === "boolean" ? input.required : undefined,
        searchable: typeof input?.searchable === "boolean" ? input.searchable : undefined,
        updatedBy: asOptionalString(input?.updatedBy) ?? user.username,
      });
      return { accepted: true };
    } catch (error) {
      return rejection(error, "Could not update attribute");
    }
  });

  ipcMain.handle(IPC.removeInventoryCategoryField, (event, fieldId: string) => {
    try {
      const user = authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      db.removeInventoryCategoryField(asString(fieldId), user.username);
      return { accepted: true };
    } catch (error) {
      return rejection(error, "Could not remove attribute");
    }
  });

  ipcMain.handle(IPC.addInventoryFieldOption, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      const id = db.addInventoryFieldOption({
        fieldId: asString(input?.fieldId),
        value: asString(input?.value),
        label: asOptionalString(input?.label),
        sortOrder: asNumber(input?.sortOrder),
      });
      return { accepted: true, id };
    } catch (error) {
      return rejection(error, "Could not add option");
    }
  });

  ipcMain.handle(IPC.inventoryFieldOptionUsage, (event, optionId: string) => {
    try {
      authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      return { accepted: true, items: db.inventoryFieldOptionUsage(asString(optionId)) };
    } catch (error) {
      return rejection(error, "Could not check where this option is used");
    }
  });

  ipcMain.handle(IPC.deleteInventoryFieldOption, (event, optionId: string) => {
    try {
      const user = authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      return { accepted: true, ...db.deleteInventoryFieldOption({ optionId: asString(optionId), deletedBy: user.username }) };
    } catch (error) {
      return rejection(error, "Could not remove option");
    }
  });

  ipcMain.handle(IPC.inventoryItemDeleteBlockers, (event, itemId: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      return { accepted: true, blockers: db.inventoryItemDeleteBlockers(asString(itemId)) };
    } catch (error) {
      return rejection(error, "Could not check this material");
    }
  });

  ipcMain.handle(IPC.deleteInventoryItem, (event, itemId: string) => {
    try {
      const user = authorizer.requirePermission(event, PERMISSION.STOCK);
      return { accepted: true, ...db.deleteInventoryItem({ itemId: asString(itemId), deletedBy: user.username }) };
    } catch (error) {
      return rejection(error, "Could not delete this material");
    }
  });

  ipcMain.handle(IPC.setInventoryItemStatus, (event, itemId: string, status: string) => {
    try {
      const user = authorizer.requirePermission(event, PERMISSION.STOCK);
      const next = status === "INACTIVE" ? "INACTIVE" : "ACTIVE";
      db.setInventoryItemStatus({ itemId: asString(itemId), status: next, updatedBy: user.username });
      return { accepted: true, status: next };
    } catch (error) {
      return rejection(error, "Could not change this material");
    }
  });

  ipcMain.handle(IPC.listInventoryItems, (_event, query?: Record<string, unknown>) =>
    db.listInventoryItems({
      search: asOptionalString(query?.search),
      categoryId: asOptionalString(query?.categoryId),
      attributes: isRecord(query?.attributes) ? asStringRecord(query.attributes) : undefined,
      status: asOptionalString(query?.status),
    })
  );

  ipcMain.handle(IPC.createInventoryItem, (event, input?: Record<string, unknown>) => {
    try {
      const user = authorizer.requirePermission(event, PERMISSION.STOCK);
      const created = db.createInventoryItem({
        categoryId: asString(input?.categoryId),
        values: asRecord(input?.values),
        valuesUrdu: isRecord(input?.valuesUrdu) ? asRecord(input.valuesUrdu) : undefined,
        unitId: asOptionalString(input?.unitId),
        stockQuantity: asOptionalNumber(input?.stockQuantity),
        costPrice: asOptionalNumber(input?.costPrice),
        createdBy: asOptionalString(input?.createdBy) ?? user.username,
        // Carried in with the material so it is never created half-configured.
        packName: asOptionalString(input?.packName),
        packingQuantity: asOptionalNumber(input?.packingQuantity),
        packingUnitId: asOptionalString(input?.packingUnitId),
      });
      return { accepted: true, ...created };
    } catch (error) {
      return rejection(error, "Could not create item");
    }
  });

  // ─── Stock corrections ────────────────────────────────────────────────────────
  // A manual correction is a claim that the shelf disagrees with the system, so it needs an
  // administrator's approval before it touches stock. Applying one directly is therefore an
  // ADMIN action — the renderer hides the button for everyone else, but hiding a button is
  // not authorisation, so the boundary enforces it too.

  ipcMain.handle(IPC.adjustInventoryStock, (event, input?: Record<string, unknown>) => {
    try {
      const user = authorizer.requireAdmin(event);
      db.applyAdminStockCorrection({
        itemId: asString(input?.itemId),
        quantity: asNumber(input?.quantity),
        reason: asString(input?.note),
        adminId: user.id,
      });
      return { accepted: true };
    } catch (error) {
      return rejection(error, "Could not update stock");
    }
  });

  // ─── Bulk import of raw material master data ──────────────────────────────────
  // Creating materials in bulk is still creating materials, so it needs the same STOCK
  // permission the single-material form does, and goes through the same insert.

  ipcMain.handle(IPC.getInventoryImportColumns, (event, categoryId?: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      return { accepted: true, columns: db.getInventoryImportColumns(asString(categoryId)) };
    } catch (error) {
      return rejection(error, "Could not read the template for this category");
    }
  });

  ipcMain.handle(IPC.importInventoryItems, (event, input?: Record<string, unknown>) => {
    try {
      const user = authorizer.requirePermission(event, PERMISSION.STOCK);
      const rows = Array.isArray(input?.rows) ? (input.rows as Array<Record<string, string>>) : [];
      return {
        accepted: true,
        result: db.importInventoryItems({
          categoryId: asString(input?.categoryId),
          rows,
          createdBy: user.username,
          dryRun: asBoolean(input?.dryRun),
        }),
      };
    } catch (error) {
      return rejection(error, "The file could not be imported");
    }
  });

  // ─── Re-filing ───────────────────────────────────────────────────────────────
  // Moving a category is setup work; moving a material is the same job as editing one, so
  // each keeps the permission that work already needed. Both are previewed first — the data
  // layer says what would happen and what would stop it, and refuses the move on the same
  // rules, so the screen can never talk somebody past a guard.

  ipcMain.handle(IPC.previewCategoryMove, (event, categoryId?: string, newParentId?: string | null) => {
    try {
      authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      return { accepted: true, preview: db.previewCategoryMove(asString(categoryId), asOptionalString(newParentId) ?? null) };
    } catch (error) {
      return rejection(error, "Could not check the move");
    }
  });

  ipcMain.handle(IPC.moveInventoryCategory, (event, categoryId?: string, newParentId?: string | null) => {
    try {
      const user = authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      db.moveInventoryCategory(asString(categoryId), asOptionalString(newParentId) ?? null, user.username);
      return { accepted: true };
    } catch (error) {
      return rejection(error, "Could not move the category");
    }
  });

  ipcMain.handle(IPC.previewInventoryItemMove, (event, itemId?: string, targetCategoryId?: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      return { accepted: true, preview: db.previewInventoryItemMove(asString(itemId), asString(targetCategoryId)) };
    } catch (error) {
      return rejection(error, "Could not check the move");
    }
  });

  ipcMain.handle(IPC.moveInventoryItem, (event, itemId?: string, targetCategoryId?: string) => {
    try {
      const user = authorizer.requirePermission(event, PERMISSION.STOCK);
      db.moveInventoryItem({
        itemId: asString(itemId),
        targetCategoryId: asString(targetCategoryId),
        movedBy: user.username,
      });
      return { accepted: true };
    } catch (error) {
      return rejection(error, "Could not move the material");
    }
  });

  // ─── A material's own ladder of units ────────────────────────────────────────
  // Reading one is part of reading stock. Building one is the same job as editing a
  // material's packing, so it takes the STOCK permission that work already needed. The data
  // layer refuses a ladder whose bottom is not the unit the stock is held in, so a ladder can
  // never change what a recorded balance means.

  ipcMain.handle(IPC.getInventoryItemUnitLadder, (event, itemId?: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      return { accepted: true, ladder: db.getInventoryItemUnitLadder(asString(itemId)) };
    } catch (error) {
      return rejection(error, "Could not read the units");
    }
  });

  ipcMain.handle(IPC.setInventoryItemUnitLadder, (event, input?: Record<string, unknown>) => {
    try {
      const user = authorizer.requirePermission(event, PERMISSION.STOCK);
      const steps = Array.isArray(input?.steps) ? (input.steps as Array<Record<string, unknown>>) : [];
      return {
        accepted: true,
        ladder: db.setInventoryItemUnitLadder({
          itemId: asString(input?.itemId),
          steps: steps.map((step) => ({
            fromUnitId: asString(step.fromUnitId),
            toUnitId: asString(step.toUnitId),
            factor: asNumber(step.factor),
          })),
          updatedBy: user.username,
        }),
      };
    } catch (error) {
      return rejection(error, "Could not save the units");
    }
  });

  ipcMain.handle(IPC.listInventoryItemUnitLadders, (event) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      return db.listInventoryItemUnitLadders();
    } catch {
      return {};
    }
  });

  // ─── Erasing a raw material, with an administrator's approval ────────────────
  // Disabling keeps a material and everything it took part in. Erasing takes it and its own
  // stock ledger away for good, which is why it is a decision rather than a button: the data
  // layer refuses it outright if anything OUTSIDE the material names it.

  ipcMain.handle(IPC.itemRemovalBlockers, (event, itemId?: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      const id = asString(itemId);
      return { accepted: true, blockers: db.itemRemovalBlockers(id), cost: db.itemRemovalCost(id) };
    } catch (error) {
      return rejection(error, "Could not check the material");
    }
  });

  ipcMain.handle(IPC.createItemRemovalRequest, (event, input?: Record<string, unknown>) => {
    try {
      const user = authorizer.requirePermission(event, PERMISSION.STOCK);
      return {
        accepted: true,
        request: db.createItemRemovalRequest({
          itemId: asString(input?.itemId),
          reason: asOptionalString(input?.reason),
          requestedBy: user.id,
        }),
      };
    } catch (error) {
      return rejection(error, "Could not send the removal for approval");
    }
  });

  ipcMain.handle(IPC.removeInventoryItemForGood, (event, itemId?: string, reason?: string) => {
    try {
      const admin = authorizer.requireAdmin(event);
      return {
        accepted: true,
        request: db.applyAdminItemRemoval({
          itemId: asString(itemId),
          adminId: admin.id,
          reason: asOptionalString(reason),
        }),
      };
    } catch (error) {
      return rejection(error, "Could not erase the material");
    }
  });

  // Re-stating a material in the unit it should always have been counted in. The figure is
  // NOT converted — 62 stays 62 and only its unit changes — so it carries a reason, which is
  // kept with the change. The data layer re-stamps the balance and every movement.
  ipcMain.handle(IPC.correctInventoryItemUnit, (event, input?: Record<string, unknown>) => {
    try {
      const user = authorizer.requirePermission(event, PERMISSION.STOCK);
      const itemId = asString(input?.itemId);
      const unitId = asString(input?.unitId);
      const reason = asString(input?.reason);
      const result = db.correctInventoryItemUnit({ itemId, unitId, reason, correctedBy: user.username });
      // Two colours of one material are counted the same way, so the change can carry across
      // them in one go — the same offer the ladder and the route already make.
      const colours =
        input?.alsoColours === true
          ? db.correctInventoryItemUnitForColours({ itemId, unitId, reason, correctedBy: user.username })
          : { applied: 0, skipped: [] };
      return { accepted: true, result, colours };
    } catch (error) {
      return rejection(error, "Could not change the unit");
    }
  });

  ipcMain.handle(IPC.inventoryItemColourSiblings, (event, itemId?: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      return db.inventoryItemColourSiblings(asString(itemId));
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.applyUnitLadderToColours, (event, itemId?: string) => {
    try {
      const user = authorizer.requirePermission(event, PERMISSION.STOCK);
      return { accepted: true, ...db.applyUnitLadderToColours({ itemId: asString(itemId), updatedBy: user.username }) };
    } catch (error) {
      return rejection(error, "Could not give the other colours these units");
    }
  });

  ipcMain.handle(IPC.listUnitLadderPresets, (event) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      return db.listUnitLadderPresets();
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.saveUnitLadderPreset, (event, input?: Record<string, unknown>) => {
    try {
      const user = authorizer.requirePermission(event, PERMISSION.STOCK);
      const steps = Array.isArray(input?.steps) ? (input.steps as Array<Record<string, unknown>>) : [];
      return {
        accepted: true,
        preset: db.saveUnitLadderPreset({
          name: asString(input?.name),
          steps: steps.map((step) => ({
            fromUnitId: asString(step.fromUnitId),
            toUnitId: asString(step.toUnitId),
            factor: asNumber(step.factor),
          })),
          createdBy: user.username,
        }),
      };
    } catch (error) {
      return rejection(error, "Could not save the set");
    }
  });

  ipcMain.handle(IPC.deleteUnitLadderPreset, (event, presetId?: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      db.deleteUnitLadderPreset(asString(presetId));
      return { accepted: true };
    } catch (error) {
      return rejection(error, "Could not delete the set");
    }
  });

  // ─── Removing a category, with an administrator's approval ───────────────────
  // Setting up categories is a setup job, so asking for one to be removed needs the same
  // access editing them needs. Carrying the removal out is the administrator's alone: the
  // data layer refuses a non-admin reviewer, and an administrator's own removal goes through
  // the identical record so there is one audit trail.

  ipcMain.handle(IPC.categoryRemovalBlockers, (event, categoryId?: string) => {
    try {
      authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      return { accepted: true, blockers: db.categoryRemovalBlockers(asString(categoryId)) };
    } catch (error) {
      return rejection(error, "Could not check the category");
    }
  });

  ipcMain.handle(IPC.createCategoryRemovalRequest, (event, input?: Record<string, unknown>) => {
    try {
      const user = authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      return {
        accepted: true,
        request: db.createCategoryRemovalRequest({
          categoryId: asString(input?.categoryId),
          reason: asOptionalString(input?.reason),
          requestedBy: user.id,
        }),
      };
    } catch (error) {
      return rejection(error, "Could not send the removal for approval");
    }
  });

  ipcMain.handle(IPC.listRemovalRequestsForTarget, (event, targetId?: string, limit?: number) => {
    try {
      authorizer.requireAnyPermission(event, RAW_MATERIAL_SETUP_ACCESS);
      return db.listRemovalRequestsForTarget(asString(targetId), asOptionalNumber(limit) ?? 20);
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.reviewRemovalRequest, (event, requestId?: string, decision?: string, reviewNotes?: string) => {
    try {
      const admin = authorizer.requireAdmin(event);
      const verdict = optionalOneOf(decision, ["APPROVED", "REJECTED"] as const);
      if (!verdict) return { accepted: false, reason: "Approve or decline the removal." };
      return {
        accepted: true,
        request: db.reviewRemovalRequest({
          requestId: asString(requestId),
          reviewerId: admin.id,
          decision: verdict,
          reviewNotes: asOptionalString(reviewNotes),
        }),
      };
    } catch (error) {
      return rejection(error, "Could not record the decision");
    }
  });

  // An administrator removing a category outright. They are the approver, so it is carried
  // out at once — through the same request record.
  ipcMain.handle(IPC.removeInventoryCategory, (event, categoryId?: string, reason?: string) => {
    try {
      const admin = authorizer.requireAdmin(event);
      return {
        accepted: true,
        request: db.applyAdminCategoryRemoval({
          categoryId: asString(categoryId),
          adminId: admin.id,
          reason: asOptionalString(reason),
        }),
      };
    } catch (error) {
      return rejection(error, "Could not remove the category");
    }
  });

  ipcMain.handle(IPC.createStockCorrectionRequest, (event, input?: Record<string, unknown>) => {
    try {
      const user = authorizer.requirePermission(event, PERMISSION.STOCK);
      return {
        accepted: true,
        request: db.createStockCorrectionRequest({
          itemId: asString(input?.itemId),
          quantity: asNumber(input?.quantity),
          reason: asString(input?.reason),
          requestedBy: user.id,
        }),
      };
    } catch (error) {
      return rejection(error, "Could not send the correction for approval");
    }
  });

  ipcMain.handle(IPC.listStockCorrectionRequests, (event, filters?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      return db.listStockCorrectionRequests({
        status: optionalOneOf(filters?.status, ["PENDING", "APPROVED", "REJECTED"] as const),
        limit: asOptionalNumber(filters?.limit),
      });
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.listStockCorrectionRequestsForItem, (event, itemId?: string, limit?: number) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      return db.listStockCorrectionRequestsForItem(asString(itemId), asOptionalNumber(limit) ?? 20);
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.reviewStockCorrectionRequest, (event, requestId?: string, decision?: string, reviewNotes?: string) => {
    try {
      const admin = authorizer.requireAdmin(event);
      const verdict = optionalOneOf(decision, ["APPROVED", "REJECTED"] as const);
      if (!verdict) return { accepted: false, reason: "Approve or decline the correction." };
      return {
        accepted: true,
        request: db.reviewStockCorrectionRequest({
          requestId: asString(requestId),
          reviewerId: admin.id,
          decision: verdict,
          reviewNotes: asOptionalString(reviewNotes),
        }),
      };
    } catch (error) {
      return rejection(error, "Could not record the decision");
    }
  });

  // The movement ledger behind one material's balance. Read-only, and gated by the same
  // permission as the stock figures it explains.
  ipcMain.handle(IPC.listInventoryStockEvents, (event, itemId?: string, limit?: number) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      return db.listInventoryStockEvents(asString(itemId), asOptionalNumber(limit) ?? 50);
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.queryInventoryStock, (_event, filters?: Record<string, unknown>) =>
    db.queryInventoryStock({
      search: asOptionalString(filters?.search),
      categoryId: asOptionalString(filters?.categoryId),
      attributes: isRecord(filters?.attributes) ? asStringRecord(filters.attributes) : undefined,
      targetUnitId: asOptionalString(filters?.targetUnitId),
    })
  );

  // Same permission as creating the material: this finishes what creating it left out.
  ipcMain.handle(IPC.setInventoryItemUnit, (event, itemId?: string, unitId?: string) => {
    try {
      const user = authorizer.requirePermission(event, PERMISSION.STOCK);
      db.setInventoryItemUnit({ itemId: asString(itemId), unitId: asString(unitId), updatedBy: user.username });
      return { accepted: true };
    } catch (error) {
      return rejection(error, "The unit could not be set");
    }
  });

  ipcMain.handle(IPC.updateInventoryItemPrice, (event, itemId?: string, costPrice?: number | null) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      if (typeof itemId !== "string" || !itemId.trim()) return { accepted: false, reason: "Item ID is required" };
      db.updateInventoryItemPrice(itemId, costPrice == null ? null : Number(costPrice));
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to update price" };
    }
  });
}
