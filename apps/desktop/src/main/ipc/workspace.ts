// Workspace messages, tasks, requests and activity.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { ACCESS_STATUS, USER_ROLE } from "@erp/domain";

export function registerWorkspaceHandlers(ctx: IpcContext): void {
  const { db, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  const workspaceUser = (token?: string) => {
    const user = typeof token === "string" ? db.getUserBySessionToken(token.trim()) : null;
    if (!user) throw new Error("Your session has expired. Please sign in again.");
    if (user.accessStatus !== ACCESS_STATUS.APPROVED) throw new Error("Workspace access is not approved");
    if (user.role !== USER_ROLE.ADMIN && !user.permissions.includes("workspace")) throw new Error("Workspace access is not permitted");
    return user;
  };

  ipcMain.handle(IPC.workspaceUsers, (_event, token?: string) => { try { workspaceUser(token); return { accepted: true, users: db.listWorkspaceUsers() }; } catch (error) { return { accepted: false, users: [], reason: error instanceof Error ? error.message : "Unable to load users" }; } });

  ipcMain.handle(IPC.workspaceTaskAssignees, (_event, token?: string) => { try { const user = workspaceUser(token); return { accepted: true, users: db.listTaskAssignees(user.id) }; } catch (error) { return { accepted: false, users: [], reason: error instanceof Error ? error.message : "Unable to load task assignees" }; } });

  ipcMain.handle(IPC.workspaceAdmin, (_event, token?: string) => { try { workspaceUser(token); const id = db.getAdministratorId(); if (!id) throw new Error("Administrator account is not configured"); return { accepted: true, userId: id }; } catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Unable to find administrator" }; } });

  ipcMain.handle(IPC.workspaceMessages, (_event, token?: string) => { try { const user = workspaceUser(token); return { accepted: true, messages: db.listWorkspaceMessages(user.id) }; } catch (error) { return { accepted: false, messages: [], reason: error instanceof Error ? error.message : "Unable to load messages" }; } });

  ipcMain.handle(IPC.workspaceSendMessage, (_event, token?: string, recipientId?: string, message?: string) => { try { const user = workspaceUser(token); if (!recipientId || !message?.trim()) throw new Error("Recipient and message are required"); return { accepted: true, id: db.sendWorkspaceMessage(user.id, recipientId, message) }; } catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Unable to send message" }; } });

  ipcMain.handle(IPC.workspaceTasks, (_event, token?: string, assignedByMe?: boolean) => { try { const user = workspaceUser(token); return { accepted: true, tasks: db.listWorkspaceTasks(user.id, Boolean(assignedByMe)) }; } catch (error) { return { accepted: false, tasks: [], reason: error instanceof Error ? error.message : "Unable to load tasks" }; } });

  ipcMain.handle(IPC.workspaceCreateTask, (_event, token?: string, input?: Record<string, unknown>) => { try { const user = workspaceUser(token); const title = String(input?.title ?? "").trim(); const assignedTo = String(input?.assignedTo ?? ""); if (!title || !assignedTo) throw new Error("Task title and assignee are required"); return { accepted: true, id: db.createWorkspaceTask({ title, description: String(input?.description ?? ""), assignedTo, assignedBy: user.id, priority: String(input?.priority ?? "NORMAL"), dueDate: typeof input?.dueDate === "string" ? input.dueDate : undefined }) }; } catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Unable to create task" }; } });

  ipcMain.handle(IPC.workspaceRequests, (_event, token?: string) => { try { const user = workspaceUser(token); return { accepted: true, requests: db.listWorkspaceRequests(user.id) }; } catch (error) { return { accepted: false, requests: [], reason: error instanceof Error ? error.message : "Unable to load requests" }; } });

  ipcMain.handle(IPC.workspaceCreateRequest, (_event, token?: string, input?: Record<string, unknown>) => { try { const user = workspaceUser(token); const title = String(input?.title ?? "").trim(); const assignedTo = String(input?.assignedTo ?? ""); if (!title || !assignedTo) throw new Error("Request title and assignee are required"); return { accepted: true, id: db.createWorkspaceRequest({ requestType: String(input?.requestType ?? "GENERAL"), title, description: String(input?.description ?? ""), requestedBy: user.id, assignedTo, priority: String(input?.priority ?? "NORMAL"), dueDate: typeof input?.dueDate === "string" ? input.dueDate : undefined }) }; } catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Unable to create request" }; } });

  ipcMain.handle(IPC.workspaceStatus, (_event, token?: string, kind?: "TASK" | "REQUEST", id?: string, status?: string) => { try { const user = workspaceUser(token); if (!kind || !id || !status) throw new Error("Workspace status data is required"); db.updateWorkspaceStatus(kind, id, user.id, status); return { accepted: true }; } catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "Unable to update status" }; } });

  ipcMain.handle(IPC.workspaceActivity, (_event, token?: string) => { try { workspaceUser(token); return { accepted: true, activity: db.listWorkspaceActivity() }; } catch (error) { return { accepted: false, activity: [], reason: error instanceof Error ? error.message : "Unable to load activity" }; } });
}
