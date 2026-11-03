// Carton stock movements — the four ways the carton figure moves (docs/42).
//
//   MANUAL_PRODUCE          Manual Production stocks cartons              +cartons
//   GATEPASS_ISSUE          a gatepass takes them out when it is made     -cartons
//   GATEPASS_CANCEL         cancelling it puts back exactly what it took  +cartons
//   MANUAL_PRODUCTION_VOID  a voided entry takes its cartons back out     -cartons
//
// The quantity is always the number of cartons, positive. The type alone decides the sign, and every
// event also carries the result (balance_delta) so a receiving computer applies exactly what the
// origin applied, as raw material does (stockEvents.ts). Every reader and writer uses this rule.

export const CARTON_STOCK_EVENT_TYPE = {
  MANUAL_PRODUCE: "MANUAL_PRODUCE",
  GATEPASS_ISSUE: "GATEPASS_ISSUE",
  GATEPASS_CANCEL: "GATEPASS_CANCEL",
  MANUAL_PRODUCTION_VOID: "MANUAL_PRODUCTION_VOID",
} as const;

export type CartonStockEventType = (typeof CARTON_STOCK_EVENT_TYPE)[keyof typeof CARTON_STOCK_EVENT_TYPE];

const TYPES: ReadonlySet<string> = new Set(Object.values(CARTON_STOCK_EVENT_TYPE));
const TAKES_OUT: ReadonlySet<string> = new Set([CARTON_STOCK_EVENT_TYPE.GATEPASS_ISSUE, CARTON_STOCK_EVENT_TYPE.MANUAL_PRODUCTION_VOID]);

export const isCartonStockEventType = (value: unknown): value is CartonStockEventType => typeof value === "string" && TYPES.has(value);

/** The change one movement makes to the carton figure. */
export const cartonStockDelta = (eventType: CartonStockEventType, cartons: number): number =>
  TAKES_OUT.has(eventType) ? -cartons : cartons;
