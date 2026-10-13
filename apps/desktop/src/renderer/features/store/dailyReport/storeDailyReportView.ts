import { STORE_DIRECTION, type StoreDayEntry, type StoreDirection } from "@erp/domain";
import { copy } from "../../../config/copy";
import { formatQuantity } from "../../rawMaterial/rawMaterial";

// How the daily report reads on screen: the words for each row. Presentation only — what a
// movement was and every total come from the report itself.

const text = copy.storeDailyReport;

/** The page's name, its line and the empty state, for one side of the store. */
export const directionText = (direction: StoreDirection) =>
  direction === STORE_DIRECTION.IN
    ? { title: text.inTitle, line: text.inLine, empty: text.emptyIn, emptyHint: text.emptyHintIn }
    : { title: text.outTitle, line: text.outLine, empty: text.emptyOut, emptyHint: text.emptyHintOut };

/** `250 KG` */
export const quantityText = (quantity: number, unitCode: string): string => `${formatQuantity(quantity)} ${unitCode}`.trim();

/** What moved: the material, or the carton's article, colour and size. */
export const entryWhat = (entry: StoreDayEntry): string =>
  entry.kind === "MATERIAL" ? entry.itemDisplayName : `${entry.article} ${entry.size} ${entry.color}`.trim();

/** How much moved: the quantity, or one carton. */
export const entryQuantity = (entry: StoreDayEntry): string =>
  entry.kind === "MATERIAL" ? quantityText(entry.quantity, entry.unitCode) : `1 ${text.cartons.toLowerCase()}`;

/** Where it came from or went, the program it was for, the label and what was typed. */
export const entryDetails = (entry: StoreDayEntry): string => {
  const parts: Array<string | null> =
    entry.kind === "MATERIAL"
      ? [
          entry.partyName ? text.from(entry.partyName) : null,
          entry.sectionName ? text.to(entry.sectionName) : null,
          entry.programCode ? text.forProgram(entry.programCode) : null,
          entry.qrId,
          entry.note,
        ]
      : [entry.programCode ? text.forProgram(entry.programCode) : null, entry.qrId];
  return parts.filter(Boolean).join(" · ");
};
