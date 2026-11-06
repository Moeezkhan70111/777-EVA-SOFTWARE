// How cloud accounts arrive on this computer: PERSON, ACCOUNT_ROLE and PERMISSION_REQUEST
// (cloud migrations 020 and 021, docs/41).
//
// Only the cloud writes these -- every account change is a cloud function -- so a PC only ever
// receives them. Each event is a whole snapshot at a revision, and the writes live in @erp/data
// (accounts.ts) because the switch to cloud accounts loads the whole state through the same code.
// This file only fits them to the applier:
//
//   WHAT IT WAITS FOR  first, this PC's switch: on local accounts every one of these is held, not
//                      applied, because the PC's own accounts are not the cloud's yet (docs/41
//                      section 7). Then a person's role, before the person; a request's person and
//                      reviewer, before the request; a deleted role's last cloud holder moving off
//                      it, before the deletion. Waits, never refusals: what they need is on its way.
//   HOW IT WRITES      only a revision newer than the one held here. An older one is a DUPLICATE.

import {
  SYNC_AGGREGATE,
  accountRoleWaitsFor,
  applyAccountRoleRevision,
  applyPermissionRequestRevision,
  applyPersonRevision,
  permissionRequestWaitsFor,
  personWaitsFor,
  readAccountRolePayload,
  readPermissionRequestPayload,
  readPersonPayload,
  waitForSwitch,
} from "@erp/data";
import { defineContract, type RegisteredContract } from "./applyContract.js";

export const personContract: RegisteredContract = defineContract({
  aggregateType: SYNC_AGGREGATE.PERSON,
  table: "app_users",
  read: readPersonPayload,
  idOf: (person) => person.personId,
  missing: (sql, person) => waitForSwitch(sql) ?? personWaitsFor(sql, person),
  write: (sql, person, replicatedAt) => applyPersonRevision(sql, person, replicatedAt),
});

export const accountRoleContract: RegisteredContract = defineContract({
  aggregateType: SYNC_AGGREGATE.ACCOUNT_ROLE,
  table: "roles",
  read: readAccountRolePayload,
  idOf: (role) => role.roleCode,
  missing: (sql, role) => waitForSwitch(sql) ?? accountRoleWaitsFor(sql, role),
  write: (sql, role, replicatedAt) => applyAccountRoleRevision(sql, role, replicatedAt),
});

export const permissionRequestContract: RegisteredContract = defineContract({
  aggregateType: SYNC_AGGREGATE.PERMISSION_REQUEST,
  table: "permission_requests",
  read: readPermissionRequestPayload,
  idOf: (request) => request.requestId,
  missing: (sql, request) => waitForSwitch(sql) ?? permissionRequestWaitsFor(sql, request),
  write: (sql, request, replicatedAt) => applyPermissionRequestRevision(sql, request, replicatedAt),
});

export const ACCOUNT_CONTRACTS: readonly RegisteredContract[] = [personContract, accountRoleContract, permissionRequestContract];
