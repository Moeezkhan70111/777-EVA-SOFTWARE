import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MemberAccessFieldResult, MemberAccessReport } from "../../types/desktopApi";
import { MemberSaveResult } from "./MemberSaveResult";

// The dialog once said "Changes saved" over a role it had kept. It now says what the save reported.

const stored = { roleCode: "store", jobRole: "Store", authorityLevel: 20, extraPermissions: [] };
const fields = (over: Partial<Record<MemberAccessFieldResult["field"], MemberAccessFieldResult["outcome"]>>): MemberAccessFieldResult[] =>
  (["ROLE", "JOB_ROLE", "AUTHORITY", "EXTRA_SCREENS"] as const).map((field) => ({ field, outcome: over[field] ?? "UNCHANGED" }));

const show = (report: MemberAccessReport) => render(<MemberSaveResult report={report} roleName={(code) => (code === "store" ? "Store Operator" : code)} />);

describe("what the member dialog says after a save", () => {
  it("names the role removed, and does not repeat the job role that went with it", () => {
    show({ stored: { ...stored, roleCode: null, jobRole: "" }, fields: fields({ ROLE: "CHANGED", JOB_ROLE: "CHANGED" }) });
    expect(screen.getByRole("status")).toHaveTextContent("Changes saved");
    expect(screen.getByRole("status")).toHaveTextContent("Role removed");
    expect(screen.queryByText(/job role/i)).not.toBeInTheDocument();
  });

  it("names the new role by its name, not its code", () => {
    show({ stored, fields: fields({ ROLE: "CHANGED" }) });
    expect(screen.getByRole("status")).toHaveTextContent("Role is now Store Operator");
  });

  it("says each thing that changed", () => {
    show({ stored, fields: fields({ AUTHORITY: "CHANGED", EXTRA_SCREENS: "CHANGED" }) });
    expect(screen.getByRole("status")).toHaveTextContent("Authority level is now 20");
    expect(screen.getByRole("status")).toHaveTextContent("Extra screens updated");
  });

  it("says a job role change when no role change explains it", () => {
    show({ stored, fields: fields({ JOB_ROLE: "CHANGED" }) });
    expect(screen.getByRole("status")).toHaveTextContent("Job role is now Store");
  });

  it("says nothing changed rather than claiming a save", () => {
    show({ stored, fields: fields({}) });
    expect(screen.getByRole("status")).toHaveTextContent("Nothing changed");
    expect(screen.queryByText("Changes saved")).not.toBeInTheDocument();
  });

  it("a role that did not take is an alert, naming what they still have, with no claim of success", () => {
    show({ stored, fields: fields({ ROLE: "NOT_SAVED" }) });
    expect(screen.getByRole("alert")).toHaveTextContent("Not saved");
    expect(screen.getByRole("alert")).toHaveTextContent("still Store Operator");
    expect(screen.queryByText("Changes saved")).not.toBeInTheDocument();
  });

  it("a role that could not be given says they still have none", () => {
    show({ stored: { ...stored, roleCode: null }, fields: fields({ ROLE: "NOT_SAVED" }) });
    expect(screen.getByRole("alert")).toHaveTextContent("still No role");
  });

  it("says each field that did not take", () => {
    show({ stored, fields: fields({ JOB_ROLE: "NOT_SAVED", AUTHORITY: "NOT_SAVED", EXTRA_SCREENS: "NOT_SAVED" }) });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Job role was not saved");
    expect(alert).toHaveTextContent("Authority level was not saved: it is still 20");
    expect(alert).toHaveTextContent("Extra screens were not saved");
  });

  it("when part took and part did not, says both, and never plain Changes saved", () => {
    show({ stored, fields: fields({ ROLE: "NOT_SAVED", AUTHORITY: "CHANGED" }) });
    expect(screen.getByRole("alert")).toHaveTextContent("still Store Operator");
    expect(screen.getByRole("status")).toHaveTextContent("Partly saved");
    expect(screen.queryByText("Changes saved")).not.toBeInTheDocument();
  });
});
