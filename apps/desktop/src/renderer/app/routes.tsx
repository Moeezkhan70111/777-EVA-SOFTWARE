export type AppRoute =
  // Every role's front door: tile cards for the pages assigned to it (features/navigation).
  | "home"
  // The KPI overview. A page like any other, behind the "dashboard" permission.
  | "dashboard"
  | "stock"
  // The Raw Material workspace. One destination with four tabs; the two routes after it are
  // deep links onto a tab, kept so the permissions that used to gate a page still gate it.
  | "raw-material"
  | "raw-material-setup"
  | "raw-material-qr-generator"
  | "raw-material-input"
  | "raw-material-output"
  // Machine Program: planning a machine's shift against raw material store stock.
  | "machine-program"
  | "history"
  | "stock-history"
  | "production-history"
  | "live-production"
  | "daily-production"
  | "daily-dispatch"
  | "live-dispatch"
  | "dispatch-history"
  | "live-return"
  | "return-history"
  | "store-home"
  | "store-in-operator"
  | "store-in-new-material"
  | "store-in-qr-generator"
  | "store-in-scanner"
  | "store-in-stock"
  | "store-in-receipts"
  | "store-in-setup"
  | "store-out-operator"
  // The Munshi's station: tile cards instead of the navbar. Its cards open the Gatepass
  // screens that already exist; munshi-stock is the raw material Stock section with the
  // Munshi's own way back.
  | "munshi-home"
  | "munshi-stock"
  | "store-scanning"
  | "store-move-out"
  | "gatepass"
  | "gatepass-list"
  | "gatepass-store-scan"
  | "gatepass-dispatch-scan"
  | "party-list"
  | "party-form"
  | "customer-ledger"
  | "customer-balance"
  | "product-list"
  | "product-form"
  | "product-lists"
  | "qr-generator"
  | "qr-management"
  | "qr-journey"
  | "discount-policy"
  | "sale-voucher-list"
  | "sale-voucher-form"
  | "purchase-voucher-list"
  | "purchase-voucher-form"
  | "supplier-ledger"
  | "supplier-balance"
  | "cash-voucher-list"
  | "cash-voucher-form"
  | "profile"
  | "change-password"
  | "settings"
  | "health"
  | "logs"
  | "workspace"
  // kept but hidden — not in nav
  | "products"
  | "inventory"
  | "production"
  | "reports"
  | "dispatch";

export const shortcutRouteMap: Record<string, AppRoute> = {
  F1: "home",
  F2: "live-production",
  F3: "stock",
  F4: "production-history",
  F5: "daily-production",
  F6: "live-dispatch",
  F7: "live-return",
  F8: "settings",
  F9: "store-scanning",
};
