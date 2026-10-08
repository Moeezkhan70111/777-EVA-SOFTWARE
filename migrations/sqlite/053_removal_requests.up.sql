-- Deleting a piece of master data needs an administrator's approval.
--
-- A category is not a record of something that happened. It is the shape every material of
-- that kind is described by. Removing one is therefore not an edit, it is a decision, and it
-- is irreversible: the category's attributes go with it. So it follows the same path a stock
-- correction already follows (migrations/sqlite/041) — a REQUEST with a reason, which an
-- administrator approves, and the approval is what performs the deletion, in the same
-- transaction that records the decision. An administrator's own removal is performed at once
-- because they are the approver, and is recorded here as an already-approved request, so
-- every deletion has one audit trail and one implementation.
--
-- Only an EMPTY category can be asked for: no sub-categories and no materials, active or
-- inactive. That is checked when the request is raised AND again when it is approved, because
-- a material can be filed under the category while the request waits.

CREATE TABLE IF NOT EXISTS removal_requests (
  id TEXT PRIMARY KEY,
  -- DEL-000001. Quoted on the notification, so the notice points back at the decision.
  request_code TEXT NOT NULL UNIQUE,
  -- What kind of thing is being removed. ITEM is allowed from the start so that asking to
  -- remove a raw material later needs no change to this table's shape -- only CATEGORY is
  -- raised today.
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  -- A snapshot of the name, so the request still reads sensibly after the thing is gone.
  target_name TEXT NOT NULL,
  -- Optional: an empty category usually speaks for itself, unlike a stock correction.
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_notes TEXT,
  FOREIGN KEY (requested_by) REFERENCES app_users(id),
  FOREIGN KEY (reviewed_by) REFERENCES app_users(id),
  CHECK (target_type IN ('CATEGORY','ITEM')),
  CHECK (status IN ('PENDING','APPROVED','REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_removal_requests_target
  ON removal_requests(target_type, target_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_removal_requests_status
  ON removal_requests(status, requested_at DESC);

-- One open request per thing. Two people asking to remove the same category would otherwise
-- both be approved, and the second approval would find nothing there.
CREATE UNIQUE INDEX IF NOT EXISTS idx_removal_requests_one_pending
  ON removal_requests(target_type, target_id) WHERE status = 'PENDING';
