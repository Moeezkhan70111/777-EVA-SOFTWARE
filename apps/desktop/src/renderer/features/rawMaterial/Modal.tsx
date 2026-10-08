// The dialog shell now lives in components/shared, because Machine Program needs the same one.
// Re-exported here so the workspace's six existing imports keep working and there is still only
// one implementation (R1).
export { Modal } from "../../components/shared/Modal";
