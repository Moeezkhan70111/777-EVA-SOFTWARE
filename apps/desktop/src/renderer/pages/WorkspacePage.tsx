import React, { useEffect, useState } from "react";
import type { DesktopApi } from "../types/desktopApi";
import { NAV_PERMISSION_MODULES } from "../components/layout/Navbar";
import { formatDateTime } from "../utils/dates";

type Tab = "messages" | "tasks" | "requests" | "notifications" | "activity" | "access";
type WorkspaceTask = { id: string; title: string; description: string; assigned_to_name: string; assigned_by_name: string; priority: string; status: string; due_date?: string | null; created_at: string; linked_entity_type?: string | null; linked_entity_id?: string | null };
type WorkspaceRequest = { id: string; request_type: string; title: string; description: string; assigned_to_name: string; requested_by_name: string; priority: string; status: string; due_date?: string | null; created_at: string };
type PermissionRequestSelfView = { id: string; permissionCode: string; reason: string | null; status: "PENDING" | "APPROVED" | "REJECTED"; createdAt: string; reviewedAt: string | null; reviewNotes: string | null };
type PermissionRequestAdminView = { id: string; userId: string; username: string; permissionCode: string; reason: string | null; status: "PENDING" | "APPROVED" | "REJECTED"; createdAt: string; reviewedAt: string | null; reviewNotes: string | null };

const labelStatus = (value: string) => value.toLowerCase().replace(/_/g, " ").replace(/^./, (character) => character.toUpperCase());
const labelPriority = (value: string) => value.toLowerCase().replace(/^./, (character) => character.toUpperCase());
const formatDate = (value?: string | null) => formatDateTime(value, "");

const PERMISSION_OPTIONS: Array<{ code: string; label: string }> = (() => {
  const out: Array<{ code: string; label: string }> = [];
  for (const module of NAV_PERMISSION_MODULES) {
    if (module.children && module.children.length > 0) {
      for (const [childId, childLabel] of module.children) {
        out.push({ code: childId, label: `${module.label} · ${childLabel}` });
      }
    } else {
      out.push({ code: module.id, label: module.label });
    }
  }
  return out;
})();

const describePermission = (code: string) => {
  const found = PERMISSION_OPTIONS.find((p) => p.code === code);
  return found?.label ?? code;
};

export const WorkspacePage = ({
  api,
  token,
  initialTab = "tasks",
}: {
  api: DesktopApi;
  token: string;
  initialTab?: Tab;
}) => {
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const [users, setUsers] = useState<Array<{ id: string; username: string; jobRole: string; role?: string }>>([]);
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [requests, setRequests] = useState<WorkspaceRequest[]>([]);
  const [messages, setMessages] = useState<Array<{ id: string; message: string; created_at: string; sender_name: string }>>([]);
  const [activity, setActivity] = useState<unknown[]>([]);
  const [notifications, setNotifications] = useState<Array<{ id: string; title: string; message: string; createdAt: string; readAt: string | null }>>([]);
  const [recipientId, setRecipientId] = useState("");
  const [message, setMessage] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [taskAssignees, setTaskAssignees] = useState<Array<{ id: string; username: string; jobRole: string }>>([]);
  const [requestTitle, setRequestTitle] = useState("");
  const [requestAssignee, setRequestAssignee] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [selectedPermission, setSelectedPermission] = useState("");
  const [requestReason, setRequestReason] = useState("");
  const [submittingAccess, setSubmittingAccess] = useState(false);
  const [myPermissionRequests, setMyPermissionRequests] = useState<PermissionRequestSelfView[]>([]);
  const [adminPermissionRequests, setAdminPermissionRequests] = useState<PermissionRequestAdminView[]>([]);
  const [sessionUserRole, setSessionUserRole] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      const [u, ta, t, r, m, a, n, myPr, adminPr, sess] = await Promise.all([
        api.workspaceUsers?.(token),
        api.workspaceTaskAssignees?.(token),
        api.workspaceTasks?.(token),
        api.workspaceRequests?.(token),
        api.workspaceMessages?.(token),
        api.workspaceActivity?.(token),
        api.getUserNotifications?.(token),
        api.getMyPermissionRequests?.(token),
        api.getPermissionRequests?.(token),
        api.getSession(token),
      ]);
      if (u?.accepted) setUsers(u.users);
      if (ta?.accepted) setTaskAssignees(ta.users);
      if (t?.accepted) setTasks(t.tasks as WorkspaceTask[]);
      if (r?.accepted) setRequests(r.requests as WorkspaceRequest[]);
      if (m?.accepted) setMessages(m.messages);
      if (a?.accepted) setActivity(a.activity);
      if (n?.accepted) setNotifications(n.notifications);
      if (myPr?.accepted) setMyPermissionRequests(myPr.requests as PermissionRequestSelfView[]);
      if (adminPr?.accepted) setAdminPermissionRequests(adminPr.requests as PermissionRequestAdminView[]);
      if (sess && typeof sess === "object" && "role" in sess) {
        setSessionUserRole((sess as { role?: string }).role ?? null);
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to load Workspace"); }
  };

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [token]);
  const display = (item: unknown) => JSON.stringify(item, null, 2).replace(/[{}\"]/g, "").trim();

  const sendMessage = async (event: React.FormEvent) => { event.preventDefault(); if (!recipientId || !message.trim()) return; const result = await api.workspaceSendMessage?.(token, recipientId, message); if (!result?.accepted) setError(result?.reason ?? "Unable to send message"); else { setMessage(""); await refresh(); } };
  const createTask = async (event: React.FormEvent) => { event.preventDefault(); if (!taskTitle || !taskAssignee) return; const result = await api.workspaceCreateTask?.(token, { title: taskTitle, assignedTo: taskAssignee }); if (!result?.accepted) setError(result?.reason ?? "Unable to create task"); else { setTaskTitle(""); setTaskAssignee(""); await refresh(); } };
  const createRequest = async (event: React.FormEvent, assignedTo = requestAssignee) => { event.preventDefault(); if (!requestTitle || !assignedTo) return; const result = await api.workspaceCreateRequest?.(token, { requestType: "GENERAL", title: requestTitle, assignedTo }); if (!result?.accepted) setError(result?.reason ?? "Unable to create request"); else { setRequestTitle(""); setRequestAssignee(""); await refresh(); } };
  const requestAdmin = async (event: React.FormEvent) => { event.preventDefault(); const admin = await api.workspaceAdmin?.(token); if (!admin?.accepted || !admin.userId) { setError(admin?.reason ?? "Administrator is unavailable"); return; } await createRequest(event, admin.userId); };
  const updateStatus = async (kind: "TASK" | "REQUEST", id: string, status: string) => { const result = await api.workspaceUpdateStatus?.(token, kind, id, status); if (!result?.accepted) setError(result?.reason ?? "Unable to update status"); else await refresh(); };

  const submitPermissionRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedPermission || submittingAccess) return;
    setSubmittingAccess(true);
    try {
      const result = await api.createPermissionRequest?.(token, selectedPermission, requestReason.trim() || undefined);
      if (!result?.accepted) {
        setError(result?.reason ?? "Unable to submit access request");
        return;
      }
      setSelectedPermission("");
      setRequestReason("");
      await refresh();
    } finally {
      setSubmittingAccess(false);
    }
  };

  const reviewPermissionRequest = async (requestId: string, decision: "APPROVED" | "REJECTED") => {
    const result = await api.reviewPermissionRequest?.(token, requestId, decision);
    if (!result?.accepted) {
      setError(result?.reason ?? "Unable to review request");
      return;
    }
    await refresh();
  };

  const isAdmin = sessionUserRole === "ADMIN";
  const pendingCount = adminPermissionRequests.filter((pr) => pr.status === "PENDING").length;

  return <div className="workspace-page">
    <div className="workspace-header"><div><div className="card-eyebrow">Workspace</div><h1 className="page-title">Workplace communication</h1></div><button type="button" className="btn btn-primary" onClick={() => setTab("tasks")}>My Tasks</button></div>
    <div className="workspace-tabs">{([["messages", "Messages"], ["tasks", "Tasks"], ["requests", "Requests"], ["access", isAdmin ? `Access Requests${pendingCount > 0 ? ` ${pendingCount}` : ""}` : "Access Requests"], ["notifications", "Notifications"], ["activity", "Activity"]] as const).map(([id, label]) => <button key={id} type="button" className={`workspace-tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>{label}{id === "notifications" && notifications.length > 0 ? ` ${notifications.length}` : ""}</button>)}</div>
    {error && <div className="auth-error" role="alert">{error}</div>}
    {tab === "messages" && <section className="workspace-panel"><div className="workspace-panel-heading"><h2>Messages</h2></div><form className="workspace-compose" onSubmit={sendMessage}><select aria-label="Recipient" value={recipientId} onChange={(event) => setRecipientId(event.target.value)}><option value="">Choose a colleague</option>{users.map((user) => <option value={user.id} key={user.id}>{user.username}{user.jobRole ? ` · ${user.jobRole}` : ""}</option>)}</select><input aria-label="Message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Write a message" /><button className="btn btn-primary" type="submit">Send</button></form>{messages.map((item) => <div className="workspace-item" key={item.id}><strong>{item.sender_name}</strong><span>{item.message}</span><time>{formatDateTime(item.created_at)}</time></div>)}</section>}
    {tab === "tasks" && <section className="workspace-panel"><div className="workspace-panel-heading"><h2>Tasks</h2><form className="workspace-inline-form" onSubmit={createTask}><input aria-label="Task title" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="New task" /><select aria-label="Task assignee" value={taskAssignee} onChange={(event) => setTaskAssignee(event.target.value)}><option value="">Assign to</option>{taskAssignees.map((user) => <option value={user.id} key={user.id}>{user.username}{user.jobRole ? ` · ${user.jobRole}` : ""}</option>)}</select><button className="btn btn-primary btn-sm" type="submit" disabled={taskAssignees.length === 0}>Assign</button></form></div>{tasks.length === 0 ? <p className="workspace-empty">No tasks assigned.</p> : tasks.map((item) => <article className="workspace-task-card" key={item.id}><div className="workspace-task-top"><h3>{item.title}</h3><span className={`workspace-status ${item.status.toLowerCase()}`}>{labelStatus(item.status)}</span></div>{item.description && <p>{item.description}</p>}<div className="workspace-task-meta"><span>Assigned to <strong>{item.assigned_to_name}</strong></span><span>Assigned by <strong>{item.assigned_by_name}</strong></span><span>Priority <strong>{labelPriority(item.priority)}</strong></span>{item.due_date && <span>Due <strong>{formatDate(item.due_date)}</strong></span>}<span>Created <strong>{formatDate(item.created_at)}</strong></span></div><div className="workspace-task-actions"><button className="btn btn-secondary btn-sm" onClick={() => void updateStatus("TASK", item.id, "IN_PROGRESS")}>Start</button><button className="btn btn-success btn-sm" onClick={() => void updateStatus("TASK", item.id, "COMPLETED")}>Complete</button></div></article>)}</section>}
    {tab === "requests" && <section className="workspace-panel"><div className="workspace-panel-heading"><h2>Requests</h2><div className="workspace-request-actions"><form className="workspace-inline-form" onSubmit={createRequest}><input aria-label="Request title" value={requestTitle} onChange={(event) => setRequestTitle(event.target.value)} placeholder="New request" /><select aria-label="Request assignee" value={requestAssignee} onChange={(event) => setRequestAssignee(event.target.value)}><option value="">Assign to</option>{users.map((user) => <option value={user.id} key={user.id}>{user.username}</option>)}</select><button className="btn btn-secondary btn-sm" type="submit">Create</button></form><form onSubmit={requestAdmin}><button className="btn btn-primary btn-sm" type="submit">Request Admin</button></form></div></div>{requests.map((item) => <article className="workspace-task-card" key={item.id}><div className="workspace-task-top"><h3>{item.title}</h3><span className={`workspace-status ${item.status.toLowerCase()}`}>{labelStatus(item.status)}</span></div>{item.description && <p>{item.description}</p>}<div className="workspace-task-meta"><span>From <strong>{item.requested_by_name}</strong></span><span>Assigned to <strong>{item.assigned_to_name}</strong></span><span>Priority <strong>{labelPriority(item.priority)}</strong></span></div><div className="workspace-task-actions"><button className="btn btn-secondary btn-sm" onClick={() => void updateStatus("REQUEST", item.id, "IN_PROGRESS")}>Start</button><button className="btn btn-success btn-sm" onClick={() => void updateStatus("REQUEST", item.id, "COMPLETED")}>Complete</button></div></article>)}</section>}
    {tab === "access" && <section className="workspace-panel">
      <div className="workspace-panel-heading"><h2>Access Requests</h2></div>
      <div style={{ display: "grid", gridTemplateColumns: isAdmin ? "1fr 1fr" : "1fr", gap: 24 }}>
        <div>
          <div className="card-eyebrow" style={{ marginBottom: 8 }}>Request Additional Access</div>
          <form className="workspace-inline-form" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }} onSubmit={submitPermissionRequest}>
            <select aria-label="Feature" value={selectedPermission} onChange={(event) => setSelectedPermission(event.target.value)} style={{ width: "100%", padding: "10px 12px" }}>
              <option value="">Select feature you need access to…</option>
              {PERMISSION_OPTIONS.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
            </select>
            <textarea aria-label="Reason" value={requestReason} onChange={(event) => setRequestReason(event.target.value)} placeholder="Short reason why you need this access (optional)" rows={3} style={{ width: "100%", padding: "10px 12px", resize: "vertical" }} />
            <div style={{ textAlign: "right" }}>
              <button className="btn btn-primary btn-sm" type="submit" disabled={!selectedPermission || submittingAccess}>
                {submittingAccess ? "Submitting…" : "Submit Request"}
              </button>
            </div>
          </form>
          <div style={{ marginTop: 24 }}>
            <div className="card-eyebrow" style={{ marginBottom: 8 }}>My Requests</div>
            {myPermissionRequests.length === 0 ? (
              <p className="workspace-empty">No access requests yet.</p>
            ) : (
              myPermissionRequests.map((item) => (
                <article className="workspace-task-card" key={item.id}>
                  <div className="workspace-task-top">
                    <h3>{describePermission(item.permissionCode)}</h3>
                    <span className={`workspace-status ${item.status.toLowerCase()}`}>{labelStatus(item.status)}</span>
                  </div>
                  {item.reason && <p><em>{item.reason}</em></p>}
                  <div className="workspace-task-meta">
                    <span>Requested <strong>{formatDate(item.createdAt)}</strong></span>
                    {item.reviewedAt && <span>Reviewed <strong>{formatDate(item.reviewedAt)}</strong></span>}
                  </div>
                  {item.reviewNotes && <p style={{ color: "var(--chrome-muted)", marginTop: 8 }}>Review note: {item.reviewNotes}</p>}
                </article>
              ))
            )}
          </div>
        </div>
        {isAdmin && (
          <div>
            <div className="card-eyebrow" style={{ marginBottom: 8 }}>Reviews{` (${pendingCount} pending)`}</div>
            {adminPermissionRequests.length === 0 ? (
              <p className="workspace-empty">No permission requests to review.</p>
            ) : (
              adminPermissionRequests.map((item) => (
                <article className="workspace-task-card" key={item.id}>
                  <div className="workspace-task-top">
                    <div>
                      <h3 style={{ marginBottom: 4 }}>{describePermission(item.permissionCode)}</h3>
                      <div style={{ color: "var(--neutral-600)", fontSize: 13 }}>from <strong>{item.username}</strong></div>
                    </div>
                    <span className={`workspace-status ${item.status.toLowerCase()}`}>{labelStatus(item.status)}</span>
                  </div>
                  {item.reason && <p><em>"{item.reason}"</em></p>}
                  <div className="workspace-task-meta">
                    <span>Requested <strong>{formatDate(item.createdAt)}</strong></span>
                  </div>
                  {item.status === "PENDING" && (
                    <div className="workspace-task-actions" style={{ marginTop: 12 }}>
                      <button className="btn btn-success btn-sm" onClick={() => void reviewPermissionRequest(item.id, "APPROVED")}>Approve</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => void reviewPermissionRequest(item.id, "REJECTED")}>Reject</button>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
        )}
      </div>
    </section>}
    {tab === "notifications" && <section className="workspace-panel"><h2>Notifications</h2>{notifications.map((item) => <div className="workspace-item" key={item.id}><strong>{item.title}</strong><span>{item.message}</span><time>{formatDateTime(item.createdAt)}</time></div>)}</section>}
    {tab === "activity" && <section className="workspace-panel"><h2>Activity</h2>{activity.map((item, index) => <div className="workspace-item" key={index}><pre>{display(item)}</pre></div>)}</section>}
  </div>;
};
