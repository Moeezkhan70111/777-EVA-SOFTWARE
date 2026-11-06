import React from "react";
import type { MemberAccessFieldResult, MemberAccessReport } from "../../types/desktopApi";
import { copy } from "../../config/copy";

// WHAT THE SAVE DID, IN WORDS, FROM THE SAVE'S OWN REPORT.
//
// Nothing here assumes success: "Changes saved" appears only when a field changed and none was left
// behind. A field that did not take is said first, as an alert, with what the person has instead.

type RoleName = (roleCode: string) => string;

const SAVE = copy.auth.memberSave;

function savedLine({ field }: MemberAccessFieldResult, report: MemberAccessReport, roleName: RoleName): string {
  const { stored } = report;
  if (field === "ROLE") return stored.roleCode === null ? SAVE.roleRemoved : SAVE.roleIs(roleName(stored.roleCode));
  if (field === "JOB_ROLE") return stored.jobRole === "" ? SAVE.jobRoleCleared : SAVE.jobRoleIs(stored.jobRole);
  if (field === "AUTHORITY") return SAVE.authorityIs(stored.authorityLevel);
  return SAVE.screensUpdated;
}

function notSavedLine({ field }: MemberAccessFieldResult, report: MemberAccessReport, roleName: RoleName): string {
  const { stored } = report;
  if (field === "ROLE") return SAVE.roleNotSaved(stored.roleCode === null ? SAVE.noRole : roleName(stored.roleCode));
  if (field === "JOB_ROLE") return SAVE.jobRoleNotSaved(stored.jobRole);
  if (field === "AUTHORITY") return SAVE.authorityNotSaved(stored.authorityLevel);
  return SAVE.screensNotSaved;
}

/** A role's own name brings the job role with it: saying both would say one thing twice. */
const worthSaying = (result: MemberAccessFieldResult, changed: readonly MemberAccessFieldResult[]): boolean =>
  result.field !== "JOB_ROLE" || !changed.some((other) => other.field === "ROLE");

export const MemberSaveResult = ({ report, roleName }: { report: MemberAccessReport; roleName: RoleName }) => {
  const changed = report.fields.filter((result) => result.outcome === "CHANGED");
  const notSaved = report.fields.filter((result) => result.outcome === "NOT_SAVED");
  const said = changed.filter((result) => worthSaying(result, changed)).map((result) => savedLine(result, report, roleName));

  if (changed.length === 0 && notSaved.length === 0) {
    return <div className="text-muted text-small" role="status">{SAVE.nothingChanged}</div>;
  }
  return (
    <>
      {notSaved.length > 0 && (
        <div className="auth-error" role="alert">
          <strong>{SAVE.notSavedTitle}</strong>
          <ul>{notSaved.map((result) => <li key={result.field}>{notSavedLine(result, report, roleName)}</li>)}</ul>
        </div>
      )}
      {said.length > 0 && (
        <div className="auth-success" role="status">
          <strong>{notSaved.length > 0 ? SAVE.partlySavedTitle : SAVE.savedTitle}</strong>
          <ul>{said.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      )}
    </>
  );
};
