import { describe, expect, it } from "vitest";
import { withoutIpcPrefix } from "./ipcError";

describe("withoutIpcPrefix", () => {
  it("leaves the handler's own message, whatever the error class", () => {
    expect(withoutIpcPrefix("Error invoking remote method 'erp:create-party': LeaseError: Master data is written on Store PC only."))
      .toBe("Master data is written on Store PC only.");
    expect(withoutIpcPrefix("Error invoking remote method 'erp:x': Error: PERMISSION_DENIED")).toBe("PERMISSION_DENIED");
  });

  it("changes nothing else", () => {
    expect(withoutIpcPrefix("The session could not be started.")).toBe("The session could not be started.");
  });
});
