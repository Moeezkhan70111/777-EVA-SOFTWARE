import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it } from "vitest";
import { QR_GENERATOR_ACCESS } from "@erp/domain";
import { AuthorizationError, Authorizer, type SessionUser } from "./authorize";

// The main process is the authority: the QR generate and print handlers ask
// requireAnyPermission(QR_GENERATOR_ACCESS). These check that call, with the real list.

const event = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;

const authorizerFor = (permissions: string[], role: SessionUser["role"] = "USER"): Authorizer =>
  new Authorizer(() => ({ id: "u-1", username: "aslam", role, accessStatus: "APPROVED", permissions }));

describe("carton QR generation — who the main process lets through (0.3.6)", () => {
  it("a store operator, who holds no QR Generator permission of their own", () => {
    expect(() => authorizerFor(["store-scanning"]).requireAnyPermission(event, QR_GENERATOR_ACCESS, "token")).not.toThrow();
  });

  it("anyone given QR Generator, as before", () => {
    expect(() => authorizerFor(["qr-generator"]).requireAnyPermission(event, QR_GENERATOR_ACCESS, "token")).not.toThrow();
  });

  it("not someone with neither — hiding the page is not what stops them", () => {
    expect(() => authorizerFor(["stock", "gatepass"]).requireAnyPermission(event, QR_GENERATOR_ACCESS, "token")).toThrow(
      AuthorizationError
    );
  });
});
