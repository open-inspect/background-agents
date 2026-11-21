import { describe, expect, it, vi } from "vitest";
import { resolveCallbackRoute } from "./callback-routes";
import type { CallbackPublicationScope } from "../authorization/callback-publication-scope";

const discordContext = {
  source: "discord",
  channelId: "100000000000000001",
  threadId: "100000000000000002",
  statusMessage: { id: "100000000000000003", startedAt: 10 },
  userId: "100000000000000004",
  repoFullName: "private/repo",
  model: "private-model",
};

const linearContext = {
  source: "linear",
  issueId: "issue-1",
  issueIdentifier: "LINEAR-1",
  issueUrl: "https://linear.example/issue-1",
  model: "private-model",
};

function completion(context: unknown) {
  return { context, sessionId: "session-1", messageId: "message-1", success: true, timestamp: 10 };
}

describe("callback routes", () => {
  it.each([
    "web",
    "extension",
    "github",
    "agent",
    "future-source",
    "__proto__",
    "constructor",
    null,
  ])("safely falls back to the legacy Slack route for %s", (source) => {
    expect(resolveCallbackRoute(source)).toBe(resolveCallbackRoute("slack"));
  });

  it("declares Slack's argument default independently of schema presence", () => {
    expect(resolveCallbackRoute("slack").defaultArgs).toEqual({});
    expect(resolveCallbackRoute("linear").defaultArgs).toBeUndefined();
    expect(resolveCallbackRoute("discord").defaultArgs).toBeUndefined();
  });

  it.each([
    ["linear", linearContext],
    ["discord", discordContext],
  ])("requires tool arguments for %s", (source, context) => {
    const route = resolveCallbackRoute(source);
    const input = {
      context,
      sessionId: "session-1",
      tool: "bash",
      callId: "call-1",
      timestamp: 10,
    };
    expect(route.prepare("toolCall", input).rejectReason).toBe("invalid_payload");
    expect(route.prepare("toolCall", { ...input, args: {} }).callback?.payload).toMatchObject({
      args: {},
    });
  });

  it("keeps Linear ungated with no denial callback", async () => {
    const scope: CallbackPublicationScope = {
      getSession: vi.fn(),
      getChannelBinding: vi.fn(),
    };
    const { callback } = resolveCallbackRoute("linear").prepare(
      "completion",
      completion(linearContext)
    );
    expect(await callback?.postGate(scope, "session-1")).toBeNull();
    expect(scope.getSession).not.toHaveBeenCalled();
    expect(scope.getChannelBinding).not.toHaveBeenCalled();
    expect(callback?.denial).toBeUndefined();
  });

  it("builds Discord stopped notifications from an explicit coordinate allowlist", () => {
    const { callback } = resolveCallbackRoute("discord").prepare("completion", {
      ...completion(discordContext),
      success: false,
      error: "private error",
    });
    expect(callback?.denial?.notification("session-1", 20)).toEqual({
      path: "/callbacks/publication_stopped",
      payload: {
        kind: "discord.publication_stopped",
        sessionId: "session-1",
        timestamp: 20,
        context: {
          channelId: "100000000000000001",
          threadId: "100000000000000002",
          statusMessage: { id: "100000000000000003", startedAt: 10 },
        },
      },
    });
  });

  it.each([
    null,
    [],
    {},
    { ...discordContext, channelId: "" },
    { ...discordContext, statusMessage: { ...discordContext.statusMessage, result: "private" } },
    { channel: "C123", threadTs: "1.2" },
  ])("rejects an invalid Discord context: %j", (context) => {
    const { callback, rejectReason } = resolveCallbackRoute("discord").prepare(
      "completion",
      completion(context)
    );
    expect(callback).toBeUndefined();
    expect(rejectReason).toBe("invalid_payload");
  });

  it.each([undefined, "", 42])("preserves a legacy Slack context with threadTs %j", (threadTs) => {
    const context = { channel: "C123", threadTs, extraLegacyField: "preserved" };
    const { callback } = resolveCallbackRoute("slack").prepare("completion", completion(context));
    expect(callback?.payload.context).toBe(context);
    expect(callback?.denial?.notification("session-1", 20)).toBeNull();
  });
});
