import React, { useEffect, useRef, useState } from "react";
import type { AppRoute } from "../app/routes";
import type { Party, PartyGroup } from "../types/desktopApi";
import { copy } from "../config/copy";

interface PartyListPageProps {
  onNavigate: (route: AppRoute, id?: string) => void;
}

export const PartyListPage: React.FC<PartyListPageProps> = ({ onNavigate }) => {
  const [parties, setParties] = useState<Party[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 20;

  // Applied filters (realtime — no Apply button)
  const [groupId, setGroupId] = useState("");
  const [status, setStatus] = useState("ALL");
  const [partyType, setPartyType] = useState("ALL");

  // Delete confirmation state
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Filter dropdown open state
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  // Group combobox state (mirrors city combobox in PartyFormPage)
  const [groupQuery, setGroupQuery] = useState("");
  const [isGroupMenuOpen, setIsGroupMenuOpen] = useState(false);
  const [highlightedGroupIndex, setHighlightedGroupIndex] = useState(0);
  const [groups, setGroups] = useState<PartyGroup[]>([]);

  const matchingGroups = groups.filter((g) =>
    g.groupName.toLowerCase().includes(groupQuery.trim().toLowerCase()),
  );

  // Load party groups once
  useEffect(() => {
    void window.desktop.api.listPartyGroups().then((result) => setGroups(result));
  }, []);

  // Close filter panel on outside click
  useEffect(() => {
    if (!filterOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [filterOpen]);

  // Fetch
  const fetchParties = async () => {
    setLoading(true);
    try {
      const result = await window.desktop.api.listParties({
        search,
        groupId: groupId || undefined,
        status: status === "ALL" ? undefined : status,
        partyType: partyType === "ALL" ? undefined : partyType,
        page,
        pageSize,
      });
      setParties(result.rows);
      setTotal(result.total);
    } catch (error) {
      console.error("Failed to fetch parties:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { setPage(1); }, [search, groupId, status, partyType]);
  useEffect(() => { void fetchParties(); }, [page, search, groupId, status, partyType]);

  // Group combobox handlers
  const handleGroupSelect = (g: PartyGroup) => {
    setGroupId(g.id);
    setGroupQuery("");
    setIsGroupMenuOpen(false);
    setHighlightedGroupIndex(0);
  };

  const handleGroupClear = () => {
    setGroupId("");
    setGroupQuery("");
    setIsGroupMenuOpen(false);
    setHighlightedGroupIndex(0);
  };

  const handleGroupKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIsGroupMenuOpen(true);
      setHighlightedGroupIndex((i) => Math.min(i + 1, matchingGroups.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedGroupIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter" && isGroupMenuOpen && matchingGroups.length > 0) {
      e.preventDefault();
      handleGroupSelect(matchingGroups[highlightedGroupIndex] ?? matchingGroups[0]);
      return;
    }
    if (e.key === "Escape") setIsGroupMenuOpen(false);
  };

  const handleEdit = (partyId: string) => onNavigate("party-form", partyId);

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      const result = await window.desktop.api.deleteParty(confirmDelete.id);
      if (result.accepted) {
        setConfirmDelete(null);
        void fetchParties();
      } else {
        alert(result.reason ?? "Failed to delete party");
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to delete party");
    } finally {
      setDeleting(false);
    }
  };

  const activeFilterCount = (groupId ? 1 : 0) + (status !== "ALL" ? 1 : 0) + (partyType !== "ALL" ? 1 : 0);
  const selectedGroupName = groups.find((g) => g.id === groupId)?.groupName ?? "";
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="page party-list-page">
      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmDelete(null); }}
        >
          <section className="member-modal party-delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
            <div className="party-delete-modal__icon" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path fillRule="evenodd" d="M9 3a3 3 0 00-3 3v1H4a1 1 0 000 2h1v11a2 2 0 002 2h10a2 2 0 002-2V9h1a1 1 0 100-2h-2V6a3 3 0 00-3-3H9zm0 2h6a1 1 0 011 1v1H8V6a1 1 0 011-1zm-1 6a1 1 0 112 0v6a1 1 0 11-2 0v-6zm4 0a1 1 0 112 0v6a1 1 0 11-2 0v-6z" clipRule="evenodd" />
              </svg>
            </div>
            <h2 id="delete-modal-title" className="party-delete-modal__title">Delete Party?</h2>
            <p className="party-delete-modal__body">
              Are you sure you want to delete <strong>{confirmDelete.name}</strong>?
              <br />
              <span className="party-delete-modal__warn">This action cannot be undone.</span>
            </p>
            <div className="member-modal-actions">
              <span />
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(null)} disabled={deleting}>{copy.common.cancel}</button>
              <button type="button" className="btn btn-danger" onClick={() => void handleDeleteConfirm()} disabled={deleting}>
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </section>
        </div>
      )}

      <div className="page-header">
        <h1>Party Management</h1>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate("party-form")}>
          Add New Party
        </button>
      </div>

      {/* Search + Filter bar */}
      <div className="filter-bar" style={{ alignItems: "center" }}>
        <div className="search-wrap" style={{ flex: "2 1 320px", minWidth: 260 }}>
          <svg className="search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M9 3a6 6 0 100 12A6 6 0 009 3zM1 9a8 8 0 1114.32 4.906l3.387 3.387a1 1 0 01-1.414 1.414l-3.387-3.387A8 8 0 011 9z" clipRule="evenodd" />
          </svg>
          <input
            type="text"
            placeholder="Search by name, Urdu name, mobile, group..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="party-filter-wrap" ref={filterRef} style={{ position: "relative" }}>
          <button
            type="button"
            className={`btn btn-secondary party-filter-btn${activeFilterCount > 0 ? " party-filter-btn--active" : ""}`}
            onClick={() => setFilterOpen((prev) => !prev)}
            aria-expanded={filterOpen}
            aria-haspopup="true"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 010 2H4a1 1 0 01-1-1zm2 4a1 1 0 011-1h8a1 1 0 010 2H6a1 1 0 01-1-1zm2 4a1 1 0 011-1h4a1 1 0 010 2H8a1 1 0 01-1-1z" clipRule="evenodd" />
            </svg>
            Filters
            {activeFilterCount > 0 && <span className="party-filter-badge">{activeFilterCount}</span>}
          </button>

          {filterOpen && (
            <div className="party-filter-panel" role="dialog" aria-label={copy.filters.filterOptions}>
              <div className="party-filter-panel__field-label">Group</div>
              <div className="city-combobox party-filter-combobox">
                <span className="city-search-icon" aria-hidden="true">⌕</span>
                <input
                  type="text"
                  className="form-input"
                  value={groupId ? selectedGroupName : groupQuery}
                  onChange={(e) => {
                    if (groupId) setGroupId("");
                    setGroupQuery(e.target.value);
                    setIsGroupMenuOpen(true);
                    setHighlightedGroupIndex(0);
                  }}
                  onFocus={(e) => { e.currentTarget.select(); setIsGroupMenuOpen(true); }}
                  onBlur={() => window.setTimeout(() => setIsGroupMenuOpen(false), 120)}
                  onKeyDown={handleGroupKeyDown}
                  placeholder="All groups"
                  role="combobox"
                  aria-expanded={isGroupMenuOpen}
                  aria-autocomplete="list"
                  autoComplete="off"
                />
                {groupId && (
                  <button type="button" className="party-combobox-clear" aria-label="Clear group filter" onMouseDown={(e) => e.preventDefault()} onClick={handleGroupClear}>×</button>
                )}
                {isGroupMenuOpen && (
                  <div className="city-options" role="listbox">
                    {matchingGroups.length === 0
                      ? <div className="city-options-empty" role="status">{copy.empty.noGroups}</div>
                      : matchingGroups.map((g, index) => (
                        <button
                          key={g.id}
                          type="button"
                          className={`city-option${(index === highlightedGroupIndex || g.id === groupId) ? " highlighted" : ""}`}
                          role="option"
                          aria-selected={g.id === groupId}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => handleGroupSelect(g)}
                        >
                          {g.groupName}
                        </button>
                      ))
                    }
                  </div>
                )}
              </div>

              <div className="party-filter-panel__field-label" style={{ marginTop: 14 }}>{copy.columns.status}</div>
              <div className="party-filter-status-group">
                {(["ALL", "ACTIVE", "INACTIVE"] as const).map((s) => (
                  <button key={s} type="button" className={`party-filter-status-btn${status === s ? " selected" : ""}`} onClick={() => setStatus(s)}>
                    {s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>

              <div className="party-filter-panel__field-label" style={{ marginTop: 14 }}>{copy.columns.type}</div>
              <div className="party-filter-status-group" style={{ flexWrap: "wrap" }}>
                {(["ALL", "CUSTOMER", "SUPPLIER", "CONTRACTOR", "DISTRIBUTOR", "DEALER", "TRANSPORTER"] as const).map((t) => (
                  <button key={t} type="button" className={`party-filter-status-btn${partyType === t ? " selected" : ""}`} onClick={() => setPartyType(t)}>
                    {t === "ALL" ? "All" : t.charAt(0) + t.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>

              {activeFilterCount > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ width: "100%", marginTop: 12, fontSize: "0.75rem", color: "var(--chrome-muted)" }} onClick={() => { setGroupId(""); setGroupQuery(""); setStatus("ALL"); setPartyType("ALL"); setFilterOpen(false); }}>
                  Clear all filters
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Active filter chips */}
      {activeFilterCount > 0 && (
        <div className="party-filter-chips">
          {groupId && (
            <span className="party-chip">
              Group: {selectedGroupName}
              <button type="button" className="party-chip__remove" aria-label="Remove group filter" onClick={handleGroupClear}>×</button>
            </span>
          )}
          {status !== "ALL" && (
            <span className="party-chip">
              {status.charAt(0) + status.slice(1).toLowerCase()}
              <button type="button" className="party-chip__remove" aria-label="Remove status filter" onClick={() => setStatus("ALL")}>×</button>
            </span>
          )}
          {partyType !== "ALL" && (
            <span className="party-chip">
              {partyType.charAt(0) + partyType.slice(1).toLowerCase()}
              <button type="button" className="party-chip__remove" aria-label="Remove type filter" onClick={() => setPartyType("ALL")}>×</button>
            </span>
          )}
        </div>
      )}

      {/* Table */}
      <div className="table-container">
        {loading ? (
          <div className="loading">{copy.common.loading}</div>
        ) : parties.length === 0 ? (
          <div className="empty-state">No parties found</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{copy.columns.code}</th>
                <th>Party Name / Urdu</th>
                <th>{copy.columns.type}</th>
                <th>{copy.columns.city}</th>
                <th>Group</th>
                <th>{copy.columns.status}</th>
                <th style={{ width: 120 }}>{copy.columns.actions}</th>
              </tr>
            </thead>
            <tbody>
              {parties.map((party) => (
                <tr key={party.id} onDoubleClick={() => handleEdit(party.id)}>
                  <td className="cell-mono">{party.partyCode}</td>
                  <td>
                    <div className="party-name-cell">
                      <span className="party-name-cell__en">{party.partyName}</span>
                      {party.partyNameUrdu && (
                        <span className="party-name-cell__ur">{party.partyNameUrdu}</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className={`party-type-badge party-type-badge--${(party.partyType ?? "CUSTOMER").toLowerCase()}`}>
                      {(party.partyType ?? "CUSTOMER").charAt(0) + (party.partyType ?? "CUSTOMER").slice(1).toLowerCase()}
                    </span>
                  </td>
                  <td>{party.city || "-"}</td>
                  <td>{party.groupName || "-"}</td>
                  <td>
                    <span className={`badge badge-${party.status.toLowerCase()}`}>
                      {party.status}
                    </span>
                  </td>
                  <td>
                    <div className="party-row-actions">
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => handleEdit(party.id)}>{copy.actions.edit}</button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => setConfirmDelete({ id: party.id, name: party.partyName })}
                      >{copy.actions.delete}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="pagination">
          <button type="button" className="btn btn-sm" disabled={page === 1} onClick={() => setPage(1)}>First</button>
          <button type="button" className="btn btn-sm" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="page-info">Page {page} of {totalPages}</span>
          <button type="button" className="btn btn-sm" disabled={page === totalPages} onClick={() => setPage(page + 1)}>Next</button>
          <button type="button" className="btn btn-sm" disabled={page === totalPages} onClick={() => setPage(totalPages)}>Last</button>
        </div>
      )}
    </div>
  );
};
