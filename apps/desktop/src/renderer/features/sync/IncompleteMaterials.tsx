import React from "react";
import { copy } from "../../config/copy";
import type { SyncWaitingEntry } from "../../types/desktopApi";
import { describeWait, stockNotice } from "./syncWaiting";

// Where the wrong number would be (owner decision 2026-10-25, point 3): someone checking one
// material needs to know whether THAT row is incomplete, not that something somewhere is.
//
//   IncompleteRowMark      on each stock row whose material waits for something
//   IncompleteMaterials    above the table: the notice once a wait has lasted, and the materials
//                          not on this computer at all, which the table cannot show

/** The row's mark, in words; the detail is read out too, not left to a tooltip (R18). */
export const IncompleteRowMark: React.FC<{ entry: SyncWaitingEntry | undefined }> = ({ entry }) => {
  if (entry === undefined) return null;
  const words = describeWait(entry);
  const arriving = entry.tier === "WAITING";
  const detail = copy.syncWaiting.rowMarkTitle(words.waitingFor, words.duration);
  return (
    <span className="rm-awaiting" title={detail}>
      {arriving ? "⏳" : "⚠"} {arriving ? copy.syncWaiting.rowMarkArriving : copy.syncWaiting.rowMark}
      <span className="sr-only">. {detail}</span>
    </span>
  );
};

export const IncompleteMaterials: React.FC<{ incomplete: Map<string, SyncWaitingEntry> }> = ({ incomplete }) => {
  const notice = stockNotice(incomplete);
  const notHere = [...incomplete.values()].filter((entry) => entry.itemHere === false);
  if (notice === null && notHere.length === 0) return null;
  return (
    <div className="sync-notice is-warning" role="status">
      <span className="sync-notice-icon" aria-hidden="true">⚠</span>
      <div className="sync-notice-body">
        {notice !== null ? <p>{notice}</p> : null}
        {notHere.length > 0 ? (
          <>
            <p className="sync-notice-title">{copy.syncWaiting.notHereTitle}</p>
            <p>{copy.syncWaiting.notHereHint}</p>
            <ul className="sync-wait-list">
              {notHere.map((entry) => {
                const words = describeWait(entry);
                return (
                  <li key={entry.dedupeKey}>
                    <strong>{words.subject}</strong> — {words.waitingFor}, {copy.syncWaiting.waitedFor(words.duration)}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
};
