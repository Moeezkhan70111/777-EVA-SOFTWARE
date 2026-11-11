import { useCallback, useState } from "react";
import { CARTON_ADJUSTMENT_KIND, type CartonAdjustmentKind } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useDataChanged } from "../../hooks/useDataChanged";
import { useLoaded, type Loaded } from "../../hooks/useLoaded";
import { useRequestId } from "../../hooks/useRequestId";
import { toIsoDate } from "../../utils/dates";
import { DATA_KIND } from "../../../shared/dataChange";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { mergeLines, type DraftHeader, type DraftLine } from "./stockAdjustmentDraft";
import { parseChoicesReply, parseHistoryReply, parsePostReply, type AdjustmentChoice, type AdjustmentHistory } from "./stockAdjustmentReply";

// The Stock Adjustment page's state and its calls to the main process. The page renders; this decides nothing about
// stock: every line is checked again by the main process when the document is posted.

const text = copy.stockAdjustment;
const REQUEST_KEY = "stock-adjustment.pending-request";
const HISTORY_PAGE_SIZE = 8;
const CARTON_CHANGES = [DATA_KIND.CARTONS, DATA_KIND.PRODUCTS] as const;
const EMPTY_HISTORY: AdjustmentHistory = { documents: [], total: 0, page: 1, pages: 1 };

export type PostOutcome = { kind: "posted"; message: string } | { kind: "refused"; message: string };

const asAnswer = <T,>(checked: { ok: true; value: T } | { ok: false; reason: string }) =>
  checked.ok ? { accepted: true, value: checked.value } : { accepted: false, reason: checked.reason, value: null };

/** One article's colours and sizes with their figure, re-read when cartons or products change anywhere. */
export const useArticleChoices = (article: string): Loaded<AdjustmentChoice[]> => {
  const api = useDesktopApi();
  const read = useCallback(async () => asAnswer(parseChoicesReply(await api.getCartonAdjustmentArticle(article))), [api, article]);
  const loaded = useLoaded(`sa-article:${article}`, article ? read : null, (answer) => answer.value ?? [], [] as AdjustmentChoice[]);
  useDataChanged(CARTON_CHANGES, () => void loaded.reload());
  return loaded;
};

export const useAdjustmentHistory = (): Loaded<AdjustmentHistory> & { page: number; setPage: (page: number) => void } => {
  const api = useDesktopApi();
  const [page, setPage] = useState(1);
  const read = useCallback(async () => asAnswer(parseHistoryReply(await api.listCartonStockAdjustments({ page, pageSize: HISTORY_PAGE_SIZE }))), [api, page]);
  const loaded = useLoaded(`sa-history:${page}`, read, (answer) => answer.value ?? EMPTY_HISTORY, EMPTY_HISTORY);
  useDataChanged(CARTON_CHANGES, () => void loaded.reload());
  return { ...loaded, page, setPage };
};

const freshHeader = (kind: CartonAdjustmentKind): DraftHeader => ({ kind, businessDate: toIsoDate(), reason: "", remarks: "" });

export const useStockAdjustment = (onPosted: () => void) => {
  const api = useDesktopApi();
  const request = useRequestId(REQUEST_KEY);
  const [header, setHeader] = useState<DraftHeader>(freshHeader(CARTON_ADJUSTMENT_KIND.OPENING));
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PostOutcome | null>(null);

  /** A different kind is a different document: its lines start again. */
  const chooseKind = (kind: CartonAdjustmentKind) => {
    if (kind === header.kind) return;
    setHeader((current) => ({ ...current, kind }));
    setLines([]);
    request.renew();
  };

  const post = async (): Promise<string | null> => {
    const requestId = request.start();
    if (requestId === null) return null;
    setBusy(true);
    try {
      const reply = parsePostReply(await api.postCartonStockAdjustment({ requestId, ...header, lines: lines.map(({ articleSizeId, color, direction, cartons }) => ({ articleSizeId, color, direction, cartons })) }));
      if (!reply.ok) {
        request.settle({ renew: false });
        return reply.reason;
      }
      request.settle({ renew: true });
      const { document } = reply.value;
      setOutcome({ kind: "posted", message: text.posted(document.code, document.cartonsIn, document.cartonsOut) });
      setLines([]);
      setHeader(freshHeader(header.kind));
      onPosted();
      return null;
    } catch (error) {
      const refused = leaseRefusalText(error);
      if (refused) request.settle({ renew: false });
      else request.unanswered();
      return refused ?? text.noAnswer;
    } finally {
      setBusy(false);
    }
  };

  return {
    header,
    setHeader,
    chooseKind,
    lines,
    addLines: (added: readonly DraftLine[]) => { setLines((current) => mergeLines(current, added)); setOutcome(null); },
    removeLine: (key: string) => setLines((current) => current.filter((line) => line.key !== key)),
    busy,
    outcome,
    post,
  };
};

export type StockAdjustmentState = ReturnType<typeof useStockAdjustment>;
