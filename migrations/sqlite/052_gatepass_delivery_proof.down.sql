-- Drops the delivery proof records. The proof FILES are deliberately left on disk: this
-- migration cannot know whether the database is being rolled back or rebuilt, and deleting
-- the only copy of someone's delivery photo to undo a schema change is not a trade this
-- should make on its own. They sit in the application's proof store and can be removed by
-- hand. (No semicolons in comments: the runner splits statements on them.)

DROP INDEX IF EXISTS idx_gatepass_delivery_proofs_current;

DROP INDEX IF EXISTS idx_gatepass_delivery_proofs_gatepass;

DROP TABLE IF EXISTS gatepass_delivery_proofs;
