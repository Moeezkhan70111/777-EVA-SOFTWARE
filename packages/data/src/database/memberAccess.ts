// WHAT A MEMBER'S SAVE MEANS, AND WHAT IT ACTUALLY DID.
//
// The dialog says "Changes saved" only if the save says so. It said it twice when it should not: a
// refused role left the rest saved (rehearsal, 2 Nov), and "No role assigned" kept the role (5 Nov).
// Both came from a save that assumed success. So the two paths, local and cloud, share two things:
//
//   settleMemberAccess   what the person's access should be, from what they have and what was asked
//   reportMemberAccess   field by field, what was stored against what was wanted. Stored is read
//                        back after the write, or is the cloud's own answer, never the request.

import { normalizePermissionCode, type MemberAccessChange } from "./users.js";

export const MEMBER_AUTHORITY = { MIN: 1, MAX: 99 } as const;

export const ACCESS_FIELD = {
  ROLE: "ROLE",
  JOB_ROLE: "JOB_ROLE",
  AUTHORITY: "AUTHORITY",
  EXTRA_SCREENS: "EXTRA_SCREENS",
} as const;
export type AccessField = (typeof ACCESS_FIELD)[keyof typeof ACCESS_FIELD];

export const FIELD_OUTCOME = {
  /** Stored as wanted, and different from before. */
  CHANGED: "CHANGED",
  /** Already as wanted: nothing to do. */
  UNCHANGED: "UNCHANGED",
  /** Stored differently from what was wanted: ignored or refused somewhere below the screen. */
  NOT_SAVED: "NOT_SAVED",
} as const;
export type FieldOutcome = (typeof FIELD_OUTCOME)[keyof typeof FIELD_OUTCOME];

export interface MemberAccessState {
  readonly roleCode: string | null;
  readonly jobRole: string;
  readonly authorityLevel: number;
  readonly extraPermissions: readonly string[];
}

export interface MemberAccessFieldResult {
  readonly field: AccessField;
  readonly outcome: FieldOutcome;
}

export interface MemberAccessReport {
  readonly fields: readonly MemberAccessFieldResult[];
  /** What the person has now. The screen shows this, not what it asked for. */
  readonly stored: MemberAccessState;
}

interface RoleFacts {
  readonly code: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

/**
 * A role taken away takes its name too: the job role is the role's name unless someone set it apart,
 * and left behind it would go on showing the role in the members list.
 */
function jobRoleAfter(current: MemberAccessState, change: MemberAccessChange, roles: readonly RoleFacts[]): string {
  const roleRemoved = current.roleCode !== null && change.roleCode === null;
  if (!roleRemoved) return change.jobRole ?? current.jobRole;
  const removedName = roles.find((role) => role.code === current.roleCode)?.name;
  return current.jobRole === removedName ? "" : current.jobRole;
}

/** Extra screens are what a person has beyond their role: the role's own are not kept twice. */
function extrasAfter(change: MemberAccessChange, roles: readonly RoleFacts[]): string[] {
  const role = roles.find((candidate) => candidate.code === change.roleCode);
  const roleScreens = new Set((role?.permissions ?? []).map(normalizePermissionCode));
  const extras = change.extraPermissions.map(normalizePermissionCode).filter((code) => code !== "" && !roleScreens.has(code));
  return [...new Set(extras)];
}

/** The access this save should leave. A null role means no role; a null job role leaves it as it is. */
export function settleMemberAccess(current: MemberAccessState, change: MemberAccessChange, roles: readonly RoleFacts[]): MemberAccessState {
  return {
    roleCode: change.roleCode,
    jobRole: jobRoleAfter(current, change, roles),
    authorityLevel: change.authorityLevel,
    extraPermissions: extrasAfter(change, roles),
  };
}

const sameScreens = (a: readonly string[], b: readonly string[]): boolean =>
  [...a].sort().join("\n") === [...b].sort().join("\n");

function outcomeOf<T>(before: T, wanted: T, stored: T, same: (a: T, b: T) => boolean): FieldOutcome {
  if (!same(stored, wanted)) return FIELD_OUTCOME.NOT_SAVED;
  return same(before, stored) ? FIELD_OUTCOME.UNCHANGED : FIELD_OUTCOME.CHANGED;
}

/** What the save did, field by field. */
export function reportMemberAccess(before: MemberAccessState, wanted: MemberAccessState, stored: MemberAccessState): MemberAccessReport {
  const equal = <T>(a: T, b: T): boolean => a === b;
  return {
    stored,
    fields: [
      { field: ACCESS_FIELD.ROLE, outcome: outcomeOf(before.roleCode, wanted.roleCode, stored.roleCode, equal) },
      { field: ACCESS_FIELD.JOB_ROLE, outcome: outcomeOf(before.jobRole, wanted.jobRole, stored.jobRole, equal) },
      { field: ACCESS_FIELD.AUTHORITY, outcome: outcomeOf(before.authorityLevel, wanted.authorityLevel, stored.authorityLevel, equal) },
      { field: ACCESS_FIELD.EXTRA_SCREENS, outcome: outcomeOf(before.extraPermissions, wanted.extraPermissions, stored.extraPermissions, sameScreens) },
    ],
  };
}
