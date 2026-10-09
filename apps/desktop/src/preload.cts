// Preload — the only bridge between the renderer and the main process.
//
// This file is bundled by esbuild (see scripts/build-renderer.mjs) so the IPC channel
// registry is inlined: sandboxed preloads cannot `require` project files at runtime.
import { contextBridge, ipcRenderer, webFrame } from "electron";
import { IPC } from "./shared/ipcChannels";

contextBridge.exposeInMainWorld("desktop", {
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  zoom: {
    getLevel: () => webFrame.getZoomLevel(),
    setLevel: (level: number) => webFrame.setZoomLevel(level),
  },
  api: {
    getRuntime: () => ipcRenderer.invoke(IPC.getRuntime),
    getSession: (token?: string) => ipcRenderer.invoke(IPC.getSession, token),
    // Encrypted, main-process persistence of the signed-in session and saved profiles.
    // The renderer keeps the token in memory only — never in localStorage.
    sessionStore: {
      load: () => ipcRenderer.invoke(IPC.sessionStoreLoad),
      save: (profile: { id: string; username: string; token: string; role: "USER" | "ADMIN"; lastUsedAt?: string }) =>
        ipcRenderer.invoke(IPC.sessionStoreSave, profile),
      remove: (token: string) => ipcRenderer.invoke(IPC.sessionStoreRemove, token),
      clear: () => ipcRenderer.invoke(IPC.sessionStoreClear),
    },
    hasAnyAdmin: () => ipcRenderer.invoke(IPC.hasAnyAdmin),
    bootstrapAdmin: (username: string, password: string, confirmPassword: string) => ipcRenderer.invoke(IPC.bootstrapAdmin, username, password, confirmPassword),
    signIn: (username: string, password: string) => ipcRenderer.invoke(IPC.signIn, username, password),
    signUp: (username: string, password: string, confirmPassword: string) => ipcRenderer.invoke(IPC.signUp, username, password, confirmPassword),
    changePassword: (currentPassword: string, newPassword: string, confirmNewPassword: string, token?: string) => ipcRenderer.invoke(IPC.changePassword, currentPassword, newPassword, confirmNewPassword, token),
    logout: (token?: string) => ipcRenderer.invoke(IPC.logout, token),
    requestAccess: (token?: string) => ipcRenderer.invoke(IPC.requestAccess, token),
    getAccessRequests: (token?: string) => ipcRenderer.invoke(IPC.getAccessRequests, token),
    getMyAccessRequest: (token?: string) => ipcRenderer.invoke(IPC.getMyAccessRequest, token),
    reviewAccessRequest: (token: string, requestId: string, decision: "APPROVED" | "REJECTED", permissions?: string[], roleCode?: string) => ipcRenderer.invoke(IPC.reviewAccessRequest, token, requestId, decision, permissions, roleCode),
    listMembers: (token?: string) => ipcRenderer.invoke(IPC.listMembers, token),
    updateUserPermissions: (token: string, userId: string, permissions: string[]) => ipcRenderer.invoke(IPC.updateUserPermissions, token, userId, permissions),
    updateMemberJobRole: (token: string, userId: string, jobRole: string) => ipcRenderer.invoke(IPC.updateMemberJobRole, token, userId, jobRole),
    updateMemberAuthority: (token: string, userId: string, authorityLevel: number) => ipcRenderer.invoke(IPC.updateMemberAuthority, token, userId, authorityLevel),
    getJobRoleOptions: (token?: string) => ipcRenderer.invoke(IPC.getJobRoleOptions, token),
    listRoles: (token?: string) => ipcRenderer.invoke(IPC.listRoles, token),
    createRole: (token: string, input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createRole, token, input),
    updateRole: (token: string, roleCode: string, input: Record<string, unknown>) => ipcRenderer.invoke(IPC.updateRole, token, roleCode, input),
    deleteRole: (token: string, roleCode: string) => ipcRenderer.invoke(IPC.deleteRole, token, roleCode),
    assignUserRole: (token: string, userId: string, roleCode: string) => ipcRenderer.invoke(IPC.assignUserRole, token, userId, roleCode),
    getUserNotifications: (token?: string) => ipcRenderer.invoke(IPC.getUserNotifications, token),
    markNotificationRead: (token: string, notificationId: string) =>
  ipcRenderer.invoke(IPC.markNotificationRead, token, notificationId),
    workspaceUsers: (token?: string) => ipcRenderer.invoke(IPC.workspaceUsers, token),
    workspaceTaskAssignees: (token?: string) => ipcRenderer.invoke(IPC.workspaceTaskAssignees, token),
    workspaceAdmin: (token?: string) => ipcRenderer.invoke(IPC.workspaceAdmin, token),
    workspaceMessages: (token?: string) => ipcRenderer.invoke(IPC.workspaceMessages, token),
    workspaceSendMessage: (token: string, recipientId: string, message: string) => ipcRenderer.invoke(IPC.workspaceSendMessage, token, recipientId, message),
    workspaceTasks: (token: string, assignedByMe?: boolean) => ipcRenderer.invoke(IPC.workspaceTasks, token, assignedByMe),
    workspaceCreateTask: (token: string, input: Record<string, unknown>) => ipcRenderer.invoke(IPC.workspaceCreateTask, token, input),
    workspaceRequests: (token: string) => ipcRenderer.invoke(IPC.workspaceRequests, token),
    workspaceCreateRequest: (token: string, input: Record<string, unknown>) => ipcRenderer.invoke(IPC.workspaceCreateRequest, token, input),
    workspaceUpdateStatus: (token: string, kind: "TASK" | "REQUEST", id: string, status: string) => ipcRenderer.invoke(IPC.workspaceStatus, token, kind, id, status),
    workspaceActivity: (token: string) => ipcRenderer.invoke(IPC.workspaceActivity, token),
    revokeUserAccess: (token: string, userId: string) => ipcRenderer.invoke(IPC.revokeUserAccess, token, userId),
    createPermissionRequest: (token: string, permissionCode: string, reason?: string) => ipcRenderer.invoke(IPC.createPermissionRequest, token, permissionCode, reason),
    getPermissionRequests: (token?: string) => ipcRenderer.invoke(IPC.getPermissionRequests, token),
    getMyPermissionRequests: (token?: string) => ipcRenderer.invoke(IPC.getMyPermissionRequests, token),
    reviewPermissionRequest: (token: string, requestId: string, decision: "APPROVED" | "REJECTED", reviewNotes?: string) => ipcRenderer.invoke(IPC.reviewPermissionRequest, token, requestId, decision, reviewNotes),
    setUserAdditionalPermissions: (token: string, userId: string, permissions: string[]) => ipcRenderer.invoke(IPC.setUserAdditionalPermissions, token, userId, permissions),
    getUserAdditionalPermissions: (token: string, userId: string) => ipcRenderer.invoke(IPC.getUserAdditionalPermissions, token, userId),
    getDashboard: () => ipcRenderer.invoke(IPC.getDashboard),
    listInventory: (search: string) => ipcRenderer.invoke(IPC.listInventory, search),
    listInventoryUnits: () => ipcRenderer.invoke(IPC.listInventoryUnits),
    listWorkSections: () => ipcRenderer.invoke(IPC.listWorkSections),
    startRawMaterialReceivingSession: (partyId: string, opts?: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.startRawMaterialReceivingSession, partyId, opts),
    getOpenRawMaterialReceivingSession: () => ipcRenderer.invoke(IPC.getOpenRawMaterialReceivingSession),
    closeRawMaterialReceivingSession: (sessionId: string) =>
      ipcRenderer.invoke(IPC.closeRawMaterialReceivingSession, sessionId),
    getRawMaterialReceivingSessionSummary: (sessionId: string) =>
      ipcRenderer.invoke(IPC.getRawMaterialReceivingSessionSummary, sessionId),
    listRawMaterialReceivingSessions: (filters?: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.listRawMaterialReceivingSessions, filters),
    rawMaterialReceiptScan: (rawScan: string, opts?: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.rawMaterialReceiptScan, rawScan, opts),
    startRawMaterialIssueSession: (opts?: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.startRawMaterialIssueSession, opts),
    closeRawMaterialIssueSession: (sessionId: string) =>
      ipcRenderer.invoke(IPC.closeRawMaterialIssueSession, sessionId),
    getRawMaterialIssueSessionSummary: (sessionId: string) =>
      ipcRenderer.invoke(IPC.getRawMaterialIssueSessionSummary, sessionId),
    rawMaterialIssueScan: (rawScan: string, opts?: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.rawMaterialIssueScan, rawScan, opts),
    createWorkSection: (name: string) => ipcRenderer.invoke(IPC.createWorkSection, name),
    listMachines: (includeInactive?: boolean) => ipcRenderer.invoke(IPC.listMachines, includeInactive),
    createMachine: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createMachine, input),
    setMachineStatus: (machineId: string, status: "ACTIVE" | "INACTIVE") =>
      ipcRenderer.invoke(IPC.setMachineStatus, machineId, status),
    assignMachineContractor: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.assignMachineContractor, input),
    listMachineProgramBoard: (programDate: string) => ipcRenderer.invoke(IPC.listMachineProgramBoard, programDate),
    getMachineProgramForDate: (machineId: string, programDate: string) =>
      ipcRenderer.invoke(IPC.getMachineProgramForDate, machineId, programDate),
    listSoleColourOptions: () => ipcRenderer.invoke(IPC.listSoleColourOptions),
    listMachineProgramDana: (colour: string) => ipcRenderer.invoke(IPC.listMachineProgramDana, colour),
    listMachineProgramArticles: () => ipcRenderer.invoke(IPC.listMachineProgramArticles),
    listMachineProgramUppers: (machineId: string, articleSizeId: string) =>
      ipcRenderer.invoke(IPC.listMachineProgramUppers, machineId, articleSizeId),
    saveMachineProgramLine: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.saveMachineProgramLine, input),
    saveMachineProgramRun: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.saveMachineProgramRun, input),
    removeMachineProgramLine: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.removeMachineProgramLine, input),
    removeMachineProgramRun: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.removeMachineProgramRun, input),
    deleteMachineProgram: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.deleteMachineProgram, input),
    setMachineProgramShift: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.setMachineProgramShift, input),
    getRawMaterialHandMoveOptions: (itemId: string, direction: string, opts?: { token?: string }) =>
      ipcRenderer.invoke(IPC.getRawMaterialHandMoveOptions, itemId, direction, opts),
    moveRawMaterialByHand: (input: Record<string, unknown>, opts?: { token?: string }) =>
      ipcRenderer.invoke(IPC.moveRawMaterialByHand, input, opts),
    listRawMaterialMovementConfig: (search?: string) => ipcRenderer.invoke(IPC.listRawMaterialMovementConfig, search),
    setRawMaterialMovementConfig: (itemId: string, input: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.setRawMaterialMovementConfig, itemId, input),
    getRawMaterialSetupTemplate: (categoryId: string) =>
      ipcRenderer.invoke(IPC.getRawMaterialSetupTemplate, categoryId),
    applyRawMaterialSetupToCategory: (categoryId: string, setup: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.applyRawMaterialSetupToCategory, categoryId, setup),
    createInventoryUnit: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createInventoryUnit, input),
    listInventoryUnitConversions: () => ipcRenderer.invoke(IPC.listInventoryUnitConversions),
    createInventoryUnitConversion: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createInventoryUnitConversion, input),
    listInventoryCategories: () => ipcRenderer.invoke(IPC.listInventoryCategories),
    createInventoryCategory: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createInventoryCategory, input),
    updateInventoryCategory: (categoryId: string, input: Record<string, unknown>) => ipcRenderer.invoke(IPC.updateInventoryCategory, categoryId, input),
    addInventoryCategoryField: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.addInventoryCategoryField, input),
    updateInventoryCategoryField: (fieldId: string, input: Record<string, unknown>) => ipcRenderer.invoke(IPC.updateInventoryCategoryField, fieldId, input),
    removeInventoryCategoryField: (fieldId: string) => ipcRenderer.invoke(IPC.removeInventoryCategoryField, fieldId),
    categoryRemovalBlockers: (categoryId: string) => ipcRenderer.invoke(IPC.categoryRemovalBlockers, categoryId),
    createCategoryRemovalRequest: (input: { categoryId: string; reason?: string }) =>
      ipcRenderer.invoke(IPC.createCategoryRemovalRequest, input),
    listRemovalRequestsForTarget: (targetId: string, limit?: number) =>
      ipcRenderer.invoke(IPC.listRemovalRequestsForTarget, targetId, limit),
    reviewRemovalRequest: (requestId: string, decision: "APPROVED" | "REJECTED", reviewNotes?: string) =>
      ipcRenderer.invoke(IPC.reviewRemovalRequest, requestId, decision, reviewNotes),
    removeInventoryCategory: (categoryId: string, reason?: string) =>
      ipcRenderer.invoke(IPC.removeInventoryCategory, categoryId, reason),
    itemRemovalBlockers: (itemId: string) => ipcRenderer.invoke(IPC.itemRemovalBlockers, itemId),
    createItemRemovalRequest: (input: { itemId: string; reason?: string }) =>
      ipcRenderer.invoke(IPC.createItemRemovalRequest, input),
    removeInventoryItemForGood: (itemId: string, reason?: string) =>
      ipcRenderer.invoke(IPC.removeInventoryItemForGood, itemId, reason),
    previewCategoryMove: (categoryId: string, newParentId: string | null) =>
      ipcRenderer.invoke(IPC.previewCategoryMove, categoryId, newParentId),
    moveInventoryCategory: (categoryId: string, newParentId: string | null) =>
      ipcRenderer.invoke(IPC.moveInventoryCategory, categoryId, newParentId),
    previewInventoryItemMove: (itemId: string, targetCategoryId: string) =>
      ipcRenderer.invoke(IPC.previewInventoryItemMove, itemId, targetCategoryId),
    moveInventoryItem: (itemId: string, targetCategoryId: string) =>
      ipcRenderer.invoke(IPC.moveInventoryItem, itemId, targetCategoryId),
    getInventoryItemUnitLadder: (itemId: string) => ipcRenderer.invoke(IPC.getInventoryItemUnitLadder, itemId),
    setInventoryItemUnitLadder: (input: { itemId: string; steps: Array<{ fromUnitId: string; toUnitId: string; factor: number }> }) =>
      ipcRenderer.invoke(IPC.setInventoryItemUnitLadder, input),
    listInventoryItemUnitLadders: () => ipcRenderer.invoke(IPC.listInventoryItemUnitLadders),
    correctInventoryItemUnit: (input: { itemId: string; unitId: string; reason: string; alsoColours?: boolean }) =>
      ipcRenderer.invoke(IPC.correctInventoryItemUnit, input),
    inventoryItemColourSiblings: (itemId: string) => ipcRenderer.invoke(IPC.inventoryItemColourSiblings, itemId),
    applyUnitLadderToColours: (itemId: string) => ipcRenderer.invoke(IPC.applyUnitLadderToColours, itemId),
    listUnitLadderPresets: () => ipcRenderer.invoke(IPC.listUnitLadderPresets),
    saveUnitLadderPreset: (input: { name: string; steps: Array<{ fromUnitId: string; toUnitId: string; factor: number }> }) =>
      ipcRenderer.invoke(IPC.saveUnitLadderPreset, input),
    deleteUnitLadderPreset: (presetId: string) => ipcRenderer.invoke(IPC.deleteUnitLadderPreset, presetId),
    deleteInventoryFieldOption: (optionId: string) => ipcRenderer.invoke(IPC.deleteInventoryFieldOption, optionId),
    inventoryFieldOptionUsage: (optionId: string) => ipcRenderer.invoke(IPC.inventoryFieldOptionUsage, optionId),
    deleteInventoryItem: (itemId: string) => ipcRenderer.invoke(IPC.deleteInventoryItem, itemId),
    inventoryItemDeleteBlockers: (itemId: string) => ipcRenderer.invoke(IPC.inventoryItemDeleteBlockers, itemId),
    setInventoryItemStatus: (itemId: string, status: "ACTIVE" | "INACTIVE") => ipcRenderer.invoke(IPC.setInventoryItemStatus, itemId, status),
    deleteRawMaterialQrBatch: (batchId: string) => ipcRenderer.invoke(IPC.deleteRawMaterialQrBatch, batchId),
    rawMaterialQrBatchDeleteBlockers: (batchId: string) => ipcRenderer.invoke(IPC.rawMaterialQrBatchDeleteBlockers, batchId),
    addInventoryFieldOption: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.addInventoryFieldOption, input),
    listInventoryItems: (query?: Record<string, unknown>) => ipcRenderer.invoke(IPC.listInventoryItems, query),
    createInventoryItem: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createInventoryItem, input),
    adjustInventoryStock: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.adjustInventoryStock, input),
    queryInventoryStock: (filters?: Record<string, unknown>) => ipcRenderer.invoke(IPC.queryInventoryStock, filters),
    listInventoryStockEvents: (itemId: string, limit?: number) => ipcRenderer.invoke(IPC.listInventoryStockEvents, itemId, limit),
    createStockCorrectionRequest: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createStockCorrectionRequest, input),
    listStockCorrectionRequests: (filters?: Record<string, unknown>) => ipcRenderer.invoke(IPC.listStockCorrectionRequests, filters),
    listStockCorrectionRequestsForItem: (itemId: string, limit?: number) => ipcRenderer.invoke(IPC.listStockCorrectionRequestsForItem, itemId, limit),
    reviewStockCorrectionRequest: (requestId: string, decision: string, reviewNotes?: string) =>
      ipcRenderer.invoke(IPC.reviewStockCorrectionRequest, requestId, decision, reviewNotes),
    getInventoryImportColumns: (categoryId: string) => ipcRenderer.invoke(IPC.getInventoryImportColumns, categoryId),
    importInventoryItems: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.importInventoryItems, input),
    updateInventoryItemPrice: (itemId: string, costPrice: number | null) => ipcRenderer.invoke(IPC.updateInventoryItemPrice, itemId, costPrice),
    setInventoryItemUnit: (itemId: string, unitId: string) => ipcRenderer.invoke(IPC.setInventoryItemUnit, itemId, unitId),
    listProducts: (query: Record<string, unknown>) => ipcRenderer.invoke(IPC.listProducts, query),
    getProduct: (id: string) => ipcRenderer.invoke(IPC.getProduct, id),
    getSaleableVariant: (id: string) => ipcRenderer.invoke(IPC.getSaleableVariant, id),
    generateQrBatch: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.generateQrBatch, input),
    listQrBatches: (input?: number | { limit?: number; sinceIso?: string }) =>
      ipcRenderer.invoke(IPC.listQrBatches, input),
    listQrCodesForBatch: (batchId: string) => ipcRenderer.invoke(IPC.listQrCodesForBatch, batchId),
    listQrColors: () => ipcRenderer.invoke(IPC.listQrColors),
    getQrSequenceState: (input: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.getQrSequenceState, input),
    searchQrCodes: (query: string, limit?: number) => ipcRenderer.invoke(IPC.searchQrCodes, query, limit),
    getQrDetail: (qrId: string) => ipcRenderer.invoke(IPC.getQrDetail, qrId),
    getQrJourney: (qrId: string) => ipcRenderer.invoke(IPC.getQrJourney, qrId),
    getQrGenerationOverview: (filter?: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.getQrGenerationOverview, filter),
    listQrGenerationFilterOptions: () => ipcRenderer.invoke(IPC.listQrGenerationFilterOptions),
    listProductListEntries: (kind: string) => ipcRenderer.invoke(IPC.listProductListEntries, kind),
    renameProductListEntry: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.renameProductListEntry, input),
    deleteProductListEntry: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.deleteProductListEntry, input),
    listQrBatchMembers: (batchId: string, opts?: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.listQrBatchMembers, batchId, opts),
    voidQrCode: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.voidQrCode, input),
    restoreQrCode: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.restoreQrCode, input),
    markQrCodeDamaged: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.markQrCodeDamaged, input),
    generateRawMaterialQrBatch: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.generateRawMaterialQrBatch, input),
    listRawMaterialQrBatches: (input?: { limit?: number; sinceIso?: string }) =>
      ipcRenderer.invoke(IPC.listRawMaterialQrBatches, input),
    listRawMaterialQrsForBatch: (batchId: string) => ipcRenderer.invoke(IPC.listRawMaterialQrsForBatch, batchId),
    getRawMaterialQrLabel: (qrId: string) => ipcRenderer.invoke(IPC.getRawMaterialQrLabel, qrId),
    getRawMaterialQrSequenceState: (input: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.getRawMaterialQrSequenceState, input),
    createProduct: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createProduct, input),
    updateProduct: (id: string, input: Record<string, unknown>) => ipcRenderer.invoke(IPC.updateProduct, id, input),
    disableProduct: (id: string) => ipcRenderer.invoke(IPC.disableProduct, id),
    enableProduct: (id: string) => ipcRenderer.invoke(IPC.enableProduct, id),
    getProductImage: (article: string) => ipcRenderer.invoke(IPC.getProductImage, article),
    saveProductImage: (article: string, dataUrl: string) => ipcRenderer.invoke(IPC.saveProductImage, article, dataUrl),
    saveRateList: (payload: { html: string; fileName: string }) => ipcRenderer.invoke(IPC.saveRateList, payload),
    printDocument: (payload: { html: string; pageSize?: { widthIn: number; heightIn: number } }) =>
      ipcRenderer.invoke(IPC.printDocument, payload),
    listHistory: (query: Record<string, unknown>) => ipcRenderer.invoke(IPC.listHistory, query),
    listDispatchHistory: (query: Record<string, unknown>) => ipcRenderer.invoke(IPC.listDispatchHistory, query),
    listDispatchSessions: (filter?: Record<string, unknown>) => ipcRenderer.invoke(IPC.listDispatchSessions, filter),
    getDispatchSession: (sessionId: string) => ipcRenderer.invoke(IPC.getDispatchSession, sessionId),
    getReport: (query: Record<string, unknown>) => ipcRenderer.invoke(IPC.getReport, query),
    processScan: (rawScan: string) => ipcRenderer.invoke(IPC.processScan, rawScan),
    dispatchScan: (rawScan: string, sessionId?: string, gatepassId?: string) => ipcRenderer.invoke(IPC.dispatchScan, rawScan, sessionId, gatepassId),
    returnLookup: (rawScan: string) => ipcRenderer.invoke(IPC.returnLookup, rawScan),
    returnScan: (rawScan: string) => ipcRenderer.invoke(IPC.returnScan, rawScan),
    listSaleReturns: (query?: Record<string, unknown>) => ipcRenderer.invoke(IPC.listSaleReturns, query),
    // Store Scanning
    storeEntryScan: (rawScan: string, opts?: { token?: string; sessionId?: string }) =>
      ipcRenderer.invoke(IPC.storeEntryScan, rawScan, opts),
    getStoreReceivingSession: (opts?: { token?: string; startNew?: boolean }) =>
      ipcRenderer.invoke(IPC.storeReceivingSession, opts),
    getStoreReceivingSessionSummary: (sessionId: string, opts?: { token?: string; recentLimit?: number }) =>
      ipcRenderer.invoke(IPC.storeReceivingSessionSummary, sessionId, opts),
    // Store Move Out
    storeExitScan: (rawScan: string, opts?: { token?: string; sessionId?: string; gatepassId?: string }) =>
      ipcRenderer.invoke(IPC.storeExitScan, rawScan, opts),
    getStoreMoveOutSession: (opts?: { token?: string; startNew?: boolean }) =>
      ipcRenderer.invoke(IPC.storeMoveOutSession, opts),
    getStoreMoveOutSessionSummary: (sessionId: string, opts?: { token?: string; recentLimit?: number }) =>
      ipcRenderer.invoke(IPC.storeMoveOutSessionSummary, sessionId, opts),
    // Gatepass
    listGatepassStock: (article: string, opts?: { token?: string }) => ipcRenderer.invoke(IPC.listGatepassStock, article, opts),
    listGatepassStoreStock: (opts?: { token?: string }) => ipcRenderer.invoke(IPC.listGatepassStoreStock, opts),
    createGatepass: (input: Record<string, unknown>, opts?: { token?: string }) => ipcRenderer.invoke(IPC.createGatepass, input, opts),
    getGatepass: (gatepassId: string, opts?: { token?: string }) => ipcRenderer.invoke(IPC.getGatepass, gatepassId, opts),
    getGatepassByNumber: (gatepassNumber: number, opts?: { token?: string }) => ipcRenderer.invoke(IPC.getGatepassByNumber, gatepassNumber, opts),
    countGatepassesByStage: (opts?: { token?: string }) => ipcRenderer.invoke(IPC.countGatepassesByStage, opts),
    getGatepassJourney: (gatepassId: string, opts?: { token?: string }) => ipcRenderer.invoke(IPC.getGatepassJourney, gatepassId, opts),
    getGatepassScanProgress: (gatepassId: string, opts?: { token?: string }) => ipcRenderer.invoke(IPC.getGatepassScanProgress, gatepassId, opts),
    saveGatepassDeliveryProof: (input: { gatepassId: string; dataUrl: string; originalName?: string }, opts?: { token?: string }) =>
      ipcRenderer.invoke(IPC.saveGatepassDeliveryProof, input, opts),
    getGatepassDeliveryProof: (gatepassId: string, opts?: { token?: string }) =>
      ipcRenderer.invoke(IPC.getGatepassDeliveryProof, gatepassId, opts),
    listGatepasses: (query?: Record<string, unknown>, opts?: { token?: string }) => ipcRenderer.invoke(IPC.listGatepasses, query, opts),
    cancelGatepass: (input: Record<string, unknown>, opts?: { token?: string }) => ipcRenderer.invoke(IPC.cancelGatepass, input, opts),
    getItemStatus: (qrId: string) => ipcRenderer.invoke(IPC.getItemStatus, qrId),
    getSettings: () => ipcRenderer.invoke(IPC.getSettings),
    saveSettings: (entries: Record<string, string>) => ipcRenderer.invoke(IPC.saveSettings, entries),
    resetDatabase: () => ipcRenderer.invoke(IPC.resetDatabase),
    createBackup: () => ipcRenderer.invoke(IPC.createBackup),
    listBackups: () => ipcRenderer.invoke(IPC.listBackups),
    getHealth: () => ipcRenderer.invoke(IPC.getHealth),
    getScannerStatus: () => ipcRenderer.invoke(IPC.scannerStatus),
    getLogs: (query: Record<string, unknown>) => ipcRenderer.invoke(IPC.getLogs, query),
    // Party Management
    listPartyGroups: () => ipcRenderer.invoke(IPC.listPartyGroups),
    createPartyGroup: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createPartyGroup, input),
    listParties: (query: Record<string, unknown>) => ipcRenderer.invoke(IPC.listParties, query),
    getParty: (id: string) => ipcRenderer.invoke(IPC.getParty, id),
    getNextPartyCode: () => ipcRenderer.invoke(IPC.getNextPartyCode),
    getNextProductCode: () => ipcRenderer.invoke(IPC.getNextProductCode),
    getCurrentPartyBalance: (partyId: string) => ipcRenderer.invoke(IPC.getCurrentPartyBalance, partyId),
    createParty: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createParty, input),
    updateParty: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.updateParty, input),
    deleteParty: (partyId: string) => ipcRenderer.invoke(IPC.deleteParty, partyId),
    getCustomerLedger: (partyId: string, query?: Record<string, unknown>) => ipcRenderer.invoke(IPC.getCustomerLedger, partyId, query),
    listCustomerBalances: (query?: Record<string, unknown>) => ipcRenderer.invoke(IPC.listCustomerBalances, query),
    listCities: () => ipcRenderer.invoke(IPC.listCities),
    getPartyDiscountReport: (partyId: string) => ipcRenderer.invoke(IPC.getPartyDiscountReport, partyId),
    resolveProductDiscount: (partyId: string, productVariantId: string) => ipcRenderer.invoke(IPC.resolveProductDiscount, partyId, productVariantId),
    resolveProductDiscountWithPrice: (partyId: string, productVariantId: string, actualPrice: number) => ipcRenderer.invoke(IPC.resolveProductDiscountWithPrice, partyId, productVariantId, actualPrice),
    // Product Group Management
    listProductGroups: () => ipcRenderer.invoke(IPC.listProductGroups),
    createProductGroup: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createProductGroup, input),
    listArticleSeries: () => ipcRenderer.invoke(IPC.listArticleSeries),
    createArticleSeries: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createArticleSeries, input),
    createPartyProductGroupDiscount: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createPartyProductGroupDiscount, input),
    createPartyArticleSeriesDiscount: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createPartyArticleSeriesDiscount, input),
    createPartyArticleDiscount: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createPartyArticleDiscount, input),
    createPartyPriceRangeDiscount: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createPartyPriceRangeDiscount, input),
    // Main Group Management
    listMainGroups: () => ipcRenderer.invoke(IPC.listMainGroups),
    createMainGroup: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createMainGroup, input),
    // Unique Product Data
    listUniqueArticles: () => ipcRenderer.invoke(IPC.listUniqueArticles),
    listUniqueSizesByArticle: (article: string) => ipcRenderer.invoke(IPC.listUniqueSizesByArticle, article),
    listUniqueColorsByArticle: (article: string) => ipcRenderer.invoke(IPC.listUniqueColorsByArticle, article),
    // Sale Voucher Management
    createSaleVoucher: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createSaleVoucher, input),
    getSaleVoucher: (voucherId: string) => ipcRenderer.invoke(IPC.getSaleVoucher, voucherId),
    findSaleVoucherByGatepass: (gatepassId: string) => ipcRenderer.invoke(IPC.findSaleVoucherByGatepass, gatepassId),
    listSaleVouchers: (query: Record<string, unknown>) => ipcRenderer.invoke(IPC.listSaleVouchers, query),
    updateSaleVoucher: (voucherId: string, input: Record<string, unknown>) => ipcRenderer.invoke(IPC.updateSaleVoucher, voucherId, input),
    addVoucherLineItem: (voucherId: string, input: Record<string, unknown>) => ipcRenderer.invoke(IPC.addVoucherLineItem, voucherId, input),
    updateVoucherLineItem: (itemId: string, input: Record<string, unknown>) => ipcRenderer.invoke(IPC.updateVoucherLineItem, itemId, input),
    deleteVoucherLineItem: (itemId: string) => ipcRenderer.invoke(IPC.deleteVoucherLineItem, itemId),
    deleteSaleVoucher: (voucherId: string) => ipcRenderer.invoke(IPC.deleteSaleVoucher, voucherId),
    // Cash Voucher Management
    getNextCashVoucherNumber: () => ipcRenderer.invoke(IPC.getNextCashVoucherNumber),
    createCashVoucher: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createCashVoucher, input),
    updateCashVoucher: (voucherId: string, input: Record<string, unknown>) => ipcRenderer.invoke(IPC.updateCashVoucher, voucherId, input),
    getCashVoucher: (id: string) => ipcRenderer.invoke(IPC.getCashVoucher, id),
    getCashVoucherByNumber: (voucherNumber: number) => ipcRenderer.invoke(IPC.getCashVoucherByNumber, voucherNumber),
    listCashVouchers: (query?: Record<string, unknown>) => ipcRenderer.invoke(IPC.listCashVouchers, query),
    deleteCashVoucher: (id: string) => ipcRenderer.invoke(IPC.deleteCashVoucher, id),
    getCustomerLedgerWithCash: (partyId: string, query?: Record<string, unknown>) => ipcRenderer.invoke(IPC.getCustomerLedgerWithCash, partyId, query),
    // Purchase Voucher Management (supplier bills)
    getNextPurchaseVoucherNumber: () => ipcRenderer.invoke(IPC.getNextPurchaseVoucherNumber),
    createPurchaseVoucher: (input: Record<string, unknown>) => ipcRenderer.invoke(IPC.createPurchaseVoucher, input),
    getPurchaseVoucher: (voucherId: string) => ipcRenderer.invoke(IPC.getPurchaseVoucher, voucherId),
    listPurchaseVouchers: (query?: Record<string, unknown>) => ipcRenderer.invoke(IPC.listPurchaseVouchers, query),
    updatePurchaseVoucher: (voucherId: string, input: Record<string, unknown>) => ipcRenderer.invoke(IPC.updatePurchaseVoucher, voucherId, input),
    deletePurchaseVoucher: (voucherId: string) => ipcRenderer.invoke(IPC.deletePurchaseVoucher, voucherId),
    getSupplierLedger: (partyId: string, query?: Record<string, unknown>) => ipcRenderer.invoke(IPC.getSupplierLedger, partyId, query),
    listSupplierBalances: (query?: Record<string, unknown>) => ipcRenderer.invoke(IPC.listSupplierBalances, query),
  },
});
