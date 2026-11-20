import { describe, expect, it } from "vitest";
import { childStatusToolEnvelopeSchema } from "./child-status-tool";

describe("child status tool contract", () => {
  it("rejects unknown versions and malformed nested response fields", () => {
    const payload = {
      version: 1,
      kind: "detail",
      session: { id: "child-1", status: "active" },
      agentMessage: "Child child-1",
    };
    expect(childStatusToolEnvelopeSchema.safeParse(payload).success).toBe(true);
    expect(childStatusToolEnvelopeSchema.safeParse({ ...payload, version: 2 }).success).toBe(false);
    expect(
      childStatusToolEnvelopeSchema.safeParse({
        ...payload,
        finalResponse: { success: "yes", textContent: [] },
      }).success
    ).toBe(false);
  });
});
