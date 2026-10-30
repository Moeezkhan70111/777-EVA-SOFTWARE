// IPC channel registry — the single source of truth for every renderer ↔ main "endpoint".
//
// `preload.cts` invokes these names and `main.ts` handles them. Nothing else in the
// application may spell an "erp:…" channel string. Adding a channel means adding it
// here first; a typo becomes a compile error instead of a runtime "No handler registered".
//
// This file is compiled for the main process (CommonJS) and must stay free of Electron
// and DOM imports so it can also be type-checked by the renderer.

export const IPC = {
  // Runtime & session
  getRuntime: "erp:get-runtime",
  getSession: "erp:get-session",
  hasAnyAdmin: "erp:has-any-admin",
  bootstrapAdmin: "erp:bootstrap-admin",
  signIn: "erp:sign-in",
  signUp: "erp:sign-up",
  changePassword: "erp:change-password",
  logout: "erp:logout",
  sessionStoreLoad: "erp:session-store-load",
  sessionStoreSave: "erp:session-store-save",
  sessionStoreRemove: "erp:session-store-remove",
  sessionStoreClear: "erp:session-store-clear",

  // Access & members
  requestAccess: "erp:request-access",
  getAccessRequests: "erp:get-access-requests",
  getMyAccessRequest: "erp:get-my-access-request",
  reviewAccessRequest: "erp:review-access-request",
  listMembers: "erp:list-members",
  updateUserPermissions: "erp:update-user-permissions",
  updateMemberJobRole: "erp:update-member-job-role",
  updateMemberAuthority: "erp:update-member-authority",
  getJobRoleOptions: "erp:get-job-role-options",
  listRoles: "erp:list-roles",
  createRole: "erp:create-role",
  updateRole: "erp:update-role",
  deleteRole: "erp:delete-role",
  assignUserRole: "erp:assign-user-role",
  getUserNotifications: "erp:get-user-notifications",
  markNotificationRead: "erp:mark-notification-read",
  revokeUserAccess: "erp:revoke-user-access",
  createPermissionRequest: "erp:create-permission-request",
  getPermissionRequests: "erp:get-permission-requests",
  getMyPermissionRequests: "erp:get-my-permission-requests",
  reviewPermissionRequest: "erp:review-permission-request",
  setUserAdditionalPermissions: "erp:set-user-additional-permissions",
  getUserAdditionalPermissions: "erp:get-user-additional-permissions",

  // Workspace
  workspaceUsers: "erp:workspace-users",
  workspaceTaskAssignees: "erp:workspace-task-assignees",
  workspaceAdmin: "erp:workspace-admin",
  workspaceMessages: "erp:workspace-messages",
  workspaceSendMessage: "erp:workspace-send-message",
  workspaceTasks: "erp:workspace-tasks",
  workspaceCreateTask: "erp:workspace-create-task",
  workspaceRequests: "erp:workspace-requests",
  workspaceCreateRequest: "erp:workspace-create-request",
  workspaceStatus: "erp:workspace-status",
  workspaceActivity: "erp:workspace-activity",

  // Dashboard & inventory
  getDashboard: "erp:get-dashboard",
  listInventory: "erp:list-inventory",
  listInventoryUnits: "erp:list-inventory-units",
  // Raw material Store movement: what one packet holds and where it goes.
  listWorkSections: "erp:list-work-sections",
  // Raw Material Input: a supplier's delivery, received one packet at a time.
  startRawMaterialReceivingSession: "erp:start-raw-material-receiving-session",
  getOpenRawMaterialReceivingSession: "erp:get-open-raw-material-receiving-session",
  closeRawMaterialReceivingSession: "erp:close-raw-material-receiving-session",
  getRawMaterialReceivingSessionSummary: "erp:get-raw-material-receiving-session-summary",
  listRawMaterialReceivingSessions: "erp:list-raw-material-receiving-sessions",
  rawMaterialReceiptScan: "erp:raw-material-receipt-scan",
  // Raw Material Output: packets leaving the store for the section that consumes them.
  startRawMaterialIssueSession: "erp:start-raw-material-issue-session",
  closeRawMaterialIssueSession: "erp:close-raw-material-issue-session",
  getRawMaterialIssueSessionSummary: "erp:get-raw-material-issue-session-summary",
  rawMaterialIssueScan: "erp:raw-material-issue-scan",
  createWorkSection: "erp:create-work-section",
  // Machine Program: what each machine's two injectors make on a date, and the uppers that
  // reserves. A reservation layer over store stock — it never moves stock, Raw Material Output does.
  listMachines: "erp:list-machines",
  createMachine: "erp:create-machine",
  setMachineStatus: "erp:set-machine-status",
  listMachineProgramDana: "erp:list-machine-program-dana",
  setProductSubGroupHasNoUpper: "erp:set-product-sub-group-has-no-upper",
  // The Machine Program: one program per machine per day, opened by the day's first QR run, and
  // the machines it is made for with their two contractors.
  listMachineDayPrograms: "erp:list-machine-day-programs",
  listCartonProgramBatches: "erp:list-carton-program-batches",
  addMachine: "erp:add-machine",
  assignMachineContractor: "erp:assign-machine-contractor",
  // Reconciliation (Phase 4): Upper Out against Production Received for one machine program.
  listReconcilablePrograms: "erp:list-reconcilable-programs",
  getProgramReconciliation: "erp:get-program-reconciliation",
  // Store Out through one open Machine Program: look it up, judge one scan, save the batch.
  openMachineProgramStoreOut: "erp:open-machine-program-store-out",
  machineProgramStoreOutCheckScan: "erp:machine-program-store-out-check-scan",
  machineProgramStoreOutSaveBatch: "erp:machine-program-store-out-save-batch",
  listMachineProgramIssueBatches: "erp:list-machine-program-issue-batches",
  // The carton QR labels owed for the uppers a program has taken out, and printing them once.
  listMachineProgramCartonPackets: "erp:list-machine-program-carton-packets",
  printMachineProgramCartons: "erp:print-machine-program-cartons",
  convertMachineProgramCartonsToB: "erp:convert-machine-program-cartons-to-b",
  // Store In: one carton label of an open program scanned back in (produced + stored in).
  machineProgramCartonIn: "erp:machine-program-carton-in",
  // Store In closing a program: how it stands against the cartons back, and Complete Program.
  getMachineProgramReconciliation: "erp:get-machine-program-reconciliation",
  completeMachineProgramProduction: "erp:complete-machine-program-production",
  returnMachineProgramUpper: "erp:return-machine-program-upper",
  convertMachineProgramUpperCartonsToB: "erp:convert-machine-program-upper-cartons-to-b",
  // Dana issued out of the store FOR a program (Machine Program Issue screen).
  listMachineProgramDanaOptions: "erp:list-machine-program-dana-options",
  issueMachineProgramDana: "erp:issue-machine-program-dana",
  listMachineProgramDanaIssues: "erp:list-machine-program-dana-issues",
  // Moving raw material in or out by hand, for loose stock that carries no label.
  getRawMaterialHandMoveOptions: "erp:get-raw-material-hand-move-options",
  moveRawMaterialByHand: "erp:move-raw-material-by-hand",
  listRawMaterialMovementConfig: "erp:list-raw-material-movement-config",
  setRawMaterialMovementConfig: "erp:set-raw-material-movement-config",
  // The pack and route a new material in a sub-category should start from, and the bulk
  // action that puts every material in one sub-category back on the same setup.
  getRawMaterialSetupTemplate: "erp:get-raw-material-setup-template",
  applyRawMaterialSetupToCategory: "erp:apply-raw-material-setup-to-category",
  listInventoryStockEvents: "erp:list-inventory-stock-events",
  // Stock corrections: a claim reviewed by an administrator before it touches stock.
  createStockCorrectionRequest: "erp:create-stock-correction-request",
  listStockCorrectionRequests: "erp:list-stock-correction-requests",
  listStockCorrectionRequestsForItem: "erp:list-stock-correction-requests-for-item",
  reviewStockCorrectionRequest: "erp:review-stock-correction-request",
  // Removing master data, with an administrator's approval.
  categoryRemovalBlockers: "erp:category-removal-blockers",
  createCategoryRemovalRequest: "erp:create-category-removal-request",
  listRemovalRequestsForTarget: "erp:list-removal-requests-for-target",
  reviewRemovalRequest: "erp:review-removal-request",
  removeInventoryCategory: "erp:remove-inventory-category",
  itemRemovalBlockers: "erp:item-removal-blockers",
  createItemRemovalRequest: "erp:create-item-removal-request",
  removeInventoryItemForGood: "erp:remove-inventory-item-for-good",
  // Re-filing: a category under another parent, a material under another category.
  previewCategoryMove: "erp:preview-category-move",
  moveInventoryCategory: "erp:move-inventory-category",
  previewInventoryItemMove: "erp:preview-inventory-item-move",
  moveInventoryItem: "erp:move-inventory-item",
  // A material's own ladder of units: 1 ROLL = 975 METRE, 1 METRE = 40 INCH.
  getInventoryItemUnitLadder: "erp:get-inventory-item-unit-ladder",
  setInventoryItemUnitLadder: "erp:set-inventory-item-unit-ladder",
  listInventoryItemUnitLadders: "erp:list-inventory-item-unit-ladders",
  correctInventoryItemUnit: "erp:correct-inventory-item-unit",
  inventoryItemColourSiblings: "erp:inventory-item-colour-siblings",
  applyUnitLadderToColours: "erp:apply-unit-ladder-to-colours",
  listUnitLadderPresets: "erp:list-unit-ladder-presets",
  saveUnitLadderPreset: "erp:save-unit-ladder-preset",
  deleteUnitLadderPreset: "erp:delete-unit-ladder-preset",
  // Bulk creation of raw materials from a spreadsheet. Master data only.
  getInventoryImportColumns: "erp:get-inventory-import-columns",
  importInventoryItems: "erp:import-inventory-items",
  createInventoryUnit: "erp:create-inventory-unit",
  listInventoryUnitConversions: "erp:list-inventory-unit-conversions",
  createInventoryUnitConversion: "erp:create-inventory-unit-conversion",
  listInventoryCategories: "erp:list-inventory-categories",
  createInventoryCategory: "erp:create-inventory-category",
  updateInventoryCategory: "erp:update-inventory-category",
  addInventoryCategoryField: "erp:add-inventory-category-field",
  updateInventoryCategoryField: "erp:update-inventory-category-field",
  removeInventoryCategoryField: "erp:remove-inventory-category-field",
  addInventoryFieldOption: "erp:add-inventory-field-option",
  deleteInventoryFieldOption: "erp:delete-inventory-field-option",
  inventoryFieldOptionUsage: "erp:inventory-field-option-usage",
  listInventoryItems: "erp:list-inventory-items",
  createInventoryItem: "erp:create-inventory-item",
  adjustInventoryStock: "erp:adjust-inventory-stock",
  queryInventoryStock: "erp:query-inventory-stock",
  updateInventoryItemPrice: "erp:update-inventory-item-price",
  setInventoryItemUnit: "erp:set-inventory-item-unit",
  deleteInventoryItem: "erp:delete-inventory-item",
  inventoryItemDeleteBlockers: "erp:inventory-item-delete-blockers",
  setInventoryItemStatus: "erp:set-inventory-item-status",

  // Products
  listProducts: "erp:list-products",
  getProduct: "erp:get-product",
  getSaleableVariant: "erp:get-saleable-variant",
  createProduct: "erp:create-product",
  updateProduct: "erp:update-product",
  disableProduct: "erp:disable-product",
  enableProduct: "erp:enable-product",
  getProductImage: "erp:get-product-image",
  saveProductImage: "erp:save-product-image",
  saveRateList: "erp:save-rate-list",
  printDocument: "erp:print-document",
  getNextProductCode: "erp:get-next-product-code",
  listProductGroups: "erp:list-product-groups",
  createProductGroup: "erp:create-product-group",
  listArticleSeries: "erp:list-article-series",
  createArticleSeries: "erp:create-article-series",
  listProductTypes: "erp:list-product-types",
  createProductType: "erp:create-product-type",
  listProductSubGroups: "erp:list-product-sub-groups",
  createProductSubGroup: "erp:create-product-sub-group",
  listMainGroups: "erp:list-main-groups",
  createMainGroup: "erp:create-main-group",
  listUniqueArticles: "erp:list-unique-articles",
  listUniqueSizesByArticle: "erp:list-unique-sizes-by-article",
  listUniqueColorsByArticle: "erp:list-unique-colors-by-article",
  listProductListEntries: "erp:list-product-list-entries",
  renameProductListEntry: "erp:rename-product-list-entry",
  deleteProductListEntry: "erp:delete-product-list-entry",

  // QR codes
  generateQrBatch: "erp:generate-qr-batch",
  listQrBatches: "erp:list-qr-batches",
  listQrCodesForBatch: "erp:list-qr-codes-for-batch",
  listQrColors: "erp:list-qr-colors",
  getQrSequenceState: "erp:get-qr-sequence-state",
  searchQrCodes: "erp:search-qr-codes",
  getQrDetail: "erp:get-qr-detail",
  getQrJourney: "erp:get-qr-journey",
  /** Whether this computer may write each leased domain now, and who does (docs/37 section W). */
  getWriteLeases: "erp:get-write-leases",
  /** The lease domains this computer holds now: synced, named the holder, caught up. */
  getHeldLeases: "erp:get-held-leases",
  getQrGenerationOverview: "erp:get-qr-generation-overview",
  listQrGenerationFilterOptions: "erp:list-qr-generation-filter-options",
  listQrBatchMembers: "erp:list-qr-batch-members",
  voidQrCode: "erp:void-qr-code",
  restoreQrCode: "erp:restore-qr-code",
  markQrCodeDamaged: "erp:mark-qr-code-damaged",

  // Raw Material QR Generator
  generateRawMaterialQrBatch: "erp:generate-raw-material-qr-batch",
  listRawMaterialQrBatches: "erp:list-raw-material-qr-batches",
  deleteRawMaterialQrBatch: "erp:delete-raw-material-qr-batch",
  rawMaterialQrBatchDeleteBlockers: "erp:raw-material-qr-batch-delete-blockers",
  listRawMaterialQrsForBatch: "erp:list-raw-material-qrs-for-batch",
  getRawMaterialQrLabel: "erp:get-raw-material-qr-label",
  getRawMaterialQrSequenceState: "erp:get-raw-material-qr-sequence-state",

  // History & reports
  listHistory: "erp:list-history",
  listDispatchHistory: "erp:list-dispatch-history",
  listDispatchSessions: "erp:list-dispatch-sessions",
  getDispatchSession: "erp:get-dispatch-session",
  getReport: "erp:get-report",
  getItemStatus: "erp:get-item-status",

  // Scanning
  processScan: "erp:process-scan",
  // Receive Production (Phase 2): a generated carton QR recorded as produced, and the day's receipts.
  receiveProduction: "erp:receive-production",
  listProductionReceipts: "erp:list-production-receipts",
  findProductionReceipt: "erp:find-production-receipt",
  recordManualProduction: "erp:record-manual-production",
  listManualProduction: "erp:list-manual-production",
  // Upper Move Out (Phase 3): upper packets issued to a named machine, and upper stock.
  issueUpperToMachine: "erp:issue-upper-to-machine",
  listUpperIssues: "erp:list-upper-issues",
  getUpperIssueSummary: "erp:get-upper-issue-summary",
  listUpperStock: "erp:list-upper-stock",
  findUpperIssue: "erp:find-upper-issue",
  dispatchScan: "erp:dispatch-scan",
  /** Read-only: who a scanned carton went out to, shown before the operator confirms. */
  returnLookup: "erp:return-lookup",
  returnScan: "erp:return-scan",
  listSaleReturns: "erp:list-sale-returns",
  storeEntryScan: "erp:store-entry-scan",
  storeReceivingSession: "erp:store-receiving-session",
  storeReceivingSessionSummary: "erp:store-receiving-session-summary",
  storeExitScan: "erp:store-exit-scan",
  storeMoveOutSession: "erp:store-move-out-session",
  storeMoveOutSessionSummary: "erp:store-move-out-session-summary",

  // Gatepass
  listGatepassStock: "erp:list-gatepass-stock",
  listGatepassStoreStock: "erp:list-gatepass-store-stock",
  createGatepass: "erp:create-gatepass",
  getGatepass: "erp:get-gatepass",
  getGatepassByNumber: "erp:get-gatepass-by-number",
  listGatepasses: "erp:list-gatepasses",
  countGatepassesByStage: "erp:count-gatepasses-by-stage",
  getGatepassJourney: "erp:get-gatepass-journey",
  getGatepassScanProgress: "erp:get-gatepass-scan-progress",
  saveGatepassDeliveryProof: "erp:save-gatepass-delivery-proof",
  getGatepassDeliveryProof: "erp:get-gatepass-delivery-proof",
  cancelGatepass: "erp:cancel-gatepass",

  // Cloud sync: read-only status, and one manual pass. No background loop exists.
  getCloudSyncStatus: "erp:get-cloud-sync-status",
  runCloudSync: "erp:run-cloud-sync",

  // Parked sync events: what stopped, and putting ONE named event back. Admin-only, never
  // automatic, and not a sync trigger -- see main/ipc/deadLetters.ts.
  listDeadLetterEvents: "erp:list-dead-letter-events",
  requeueDeadLetterEvent: "erp:requeue-dead-letter-event",

  // What this computer and the others are waiting on, and sending one master record again for
  // a computer that waits for it -- see main/ipc/syncWaiting.ts.
  getSyncWaiting: "erp:get-sync-waiting",
  getFactorySyncHealth: "erp:get-factory-sync-health",
  sendMasterRecordAgain: "erp:send-master-record-again",

  // Main to renderer, not a request: what kind of data a sync just changed (shared/dataChange.ts).
  dataChanged: "erp:data-changed",

  // The one-time backfill: what the store PC held before it synced -- see main/ipc/backfill.ts.
  getBackfillPlan: "erp:get-backfill-plan",
  runBackfill: "erp:run-backfill",

  // This computer's document-number range: read-only status, the one-time adoption for the
  // existing-data machine, and the one-time assignment for a second computer.
  getNumberBlockStatus: "erp:get-number-block-status",
  adoptNumberBlock: "erp:adopt-number-block",
  assignNumberBlock: "erp:assign-number-block",

  // Settings, backup, health, logs
  getSettings: "erp:get-settings",
  saveSettings: "erp:save-settings",
  resetDatabase: "erp:reset-database",
  createBackup: "erp:create-backup",
  listBackups: "erp:list-backups",
  getHealth: "erp:get-health",
  scannerStatus: "erp:scanner-status",
  getLogs: "erp:get-logs",

  // Parties
  listPartyGroups: "erp:list-party-groups",
  createPartyGroup: "erp:create-party-group",
  listParties: "erp:list-parties",
  getParty: "erp:get-party",
  getNextPartyCode: "erp:get-next-party-code",
  getCurrentPartyBalance: "erp:get-current-party-balance",
  createParty: "erp:create-party",
  updateParty: "erp:update-party",
  deleteParty: "erp:delete-party",
  listCities: "erp:list-cities",
  getCustomerLedger: "erp:get-customer-ledger",
  listCustomerBalances: "erp:list-customer-balances",
  getCustomerLedgerWithCash: "erp:get-customer-ledger-with-cash",

  // Discounts
  getPartyDiscountReport: "erp:get-party-discount-report",
  resolveProductDiscount: "erp:resolve-product-discount",
  resolveProductDiscountWithPrice: "erp:resolve-product-discount-with-price",
  createPartyProductGroupDiscount: "erp:create-party-product-group-discount",
  createPartyArticleSeriesDiscount: "erp:create-party-article-series-discount",
  createPartyArticleDiscount: "erp:create-party-article-discount",
  createPartyPriceRangeDiscount: "erp:create-party-price-range-discount",

  // Sale vouchers
  createSaleVoucher: "erp:create-sale-voucher",
  getSaleVoucher: "erp:get-sale-voucher",
  findSaleVoucherByGatepass: "erp:find-sale-voucher-by-gatepass",
  listSaleVouchers: "erp:list-sale-vouchers",
  updateSaleVoucher: "erp:update-sale-voucher",
  addVoucherLineItem: "erp:add-voucher-line-item",
  updateVoucherLineItem: "erp:update-voucher-line-item",
  deleteVoucherLineItem: "erp:delete-voucher-line-item",
  deleteSaleVoucher: "erp:delete-sale-voucher",

  // Cash vouchers
  getNextCashVoucherNumber: "erp:get-next-cash-voucher-number",
  createCashVoucher: "erp:create-cash-voucher",
  updateCashVoucher: "erp:update-cash-voucher",
  getCashVoucher: "erp:get-cash-voucher",
  getCashVoucherByNumber: "erp:get-cash-voucher-by-number",
  listCashVouchers: "erp:list-cash-vouchers",
  deleteCashVoucher: "erp:delete-cash-voucher",

  // Purchase vouchers (suppliers)
  getNextPurchaseVoucherNumber: "erp:get-next-purchase-voucher-number",
  createPurchaseVoucher: "erp:create-purchase-voucher",
  getPurchaseVoucher: "erp:get-purchase-voucher",
  listPurchaseVouchers: "erp:list-purchase-vouchers",
  updatePurchaseVoucher: "erp:update-purchase-voucher",
  deletePurchaseVoucher: "erp:delete-purchase-voucher",
  getSupplierLedger: "erp:get-supplier-ledger",
  listSupplierBalances: "erp:list-supplier-balances",
  listContractorLedgerAccounts: "erp:list-contractor-ledger-accounts",
  getContractorLedger: "erp:get-contractor-ledger",
  getStoreDailyReport: "erp:get-store-daily-report",

  // Automatic updates. Read-only status for the prompt, plus the two things an operator can do.
  // Polled, not pushed: the bridge is invoke-only — see main/updater.ts.
  getUpdateStatus: "erp:get-update-status",
  checkForUpdates: "erp:check-for-updates",
  installUpdate: "erp:install-update",
  // Throws away a downloaded update so it cannot install on quit. Admin-only: unlike installing,
  // this changes what OTHER people's restarts will do.
  discardUpdate: "erp:discard-update",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
