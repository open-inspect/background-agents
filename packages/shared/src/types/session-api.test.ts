import { describe, expect, it } from "vitest";
import {
  discordCallbackContextSchema,
  discordPublicationStoppedCallbackPayloadSchema,
  discordPublicationStoppedCallbackSchema,
  discordSnowflakeSchema,
  DISCORD_PUBLICATION_STOPPED_KIND,
  linearCallbackContextSchema,
  linearCompletionCallbackSchema,
  linearStartCallbackSchema,
  linearToolCallCallbackSchema,
} from "./session-api";

const legacyContext = {
  source: "linear",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueUrl: "https://linear.app/acme/issue/ENG-1",
  model: "anthropic/claude-haiku-4-5",
};

describe("Linear callback channel context", () => {
  it.each([false, true])(
    "preserves the external team with transitionIssueOnStart=%s",
    (transitionIssueOnStart) => {
      const context = {
        ...legacyContext,
        organizationId: "org-1",
        appUserId: "app-user-1",
        transitionIssueOnStart,
        linearTeamId: "external-team-1",
      };

      expect(linearCallbackContextSchema.parse(context)).toEqual(context);
      const callback = {
        sessionId: "session-1",
        messageId: "message-1",
        timestamp: 123,
        signature: "signature",
        context,
      };
      expect(linearStartCallbackSchema.parse(callback).context.linearTeamId).toBe(
        "external-team-1"
      );
      expect(
        linearCompletionCallbackSchema.parse({ ...callback, success: true }).context.linearTeamId
      ).toBe("external-team-1");
      expect(
        linearToolCallCallbackSchema.parse({
          sessionId: "session-1",
          timestamp: 123,
          signature: "signature",
          context,
          tool: "bash",
          args: {},
          callId: "call-1",
        }).context.linearTeamId
      ).toBe("external-team-1");
    }
  );

  it("accepts persisted contexts that predate linearTeamId", () => {
    expect(linearCallbackContextSchema.parse(legacyContext)).toEqual(legacyContext);
    expect(
      linearCompletionCallbackSchema.safeParse({
        sessionId: "session-1",
        messageId: "message-1",
        success: true,
        timestamp: 123,
        signature: "signature",
        context: legacyContext,
      }).success
    ).toBe(true);
  });

  it.each(["", " \t ", null, 123])("rejects an invalid external team ID: %s", (linearTeamId) => {
    expect(linearCallbackContextSchema.safeParse({ ...legacyContext, linearTeamId }).success).toBe(
      false
    );
  });

  it("does not accept an internal owner teamId as callback channel context", () => {
    expect(
      linearCallbackContextSchema.safeParse({ ...legacyContext, teamId: "internal-team-1" }).success
    ).toBe(false);
  });
});

const discordContext = {
  source: "discord",
  channelId: "12345678901234567",
  threadId: "123456789012345678",
  userId: "1234567890123456789",
  repoFullName: "octo/repo",
  model: "anthropic/claude-opus-5",
  statusMessage: { id: "12345678901234567890", startedAt: 1_699_999_999_000 },
};

describe("Discord callback context", () => {
  it("preserves snowflakes of 17 to 20 digits as strings", () => {
    expect(discordCallbackContextSchema.parse(discordContext)).toEqual(discordContext);
  });

  it.each([
    "1234567890123456",
    "123456789012345678901",
    " 12345678901234567",
    "12345678901234567\n",
    "1234567890123456a",
    12345678901234567n,
  ])("rejects malformed snowflakes: %s", (id) => {
    expect(discordSnowflakeSchema.safeParse(id).success).toBe(false);
  });

  it.each([
    { channelId: "channel-1" },
    { threadId: "thread-1" },
    { userId: "user-1" },
    { statusMessage: { ...discordContext.statusMessage, id: "status-1" } },
  ])("rejects malformed IDs in each callback coordinate: %j", (fields) => {
    expect(discordCallbackContextSchema.safeParse({ ...discordContext, ...fields }).success).toBe(
      false
    );
  });
});

describe("Discord publication-stopped callbacks", () => {
  const { channelId, threadId, statusMessage } = discordContext;
  const payload = {
    kind: DISCORD_PUBLICATION_STOPPED_KIND,
    sessionId: "session-1",
    timestamp: 1_700_000_000_000,
    context: { channelId, threadId, statusMessage },
  };

  it("accepts only the dedicated unsigned and signed shapes", () => {
    expect(discordPublicationStoppedCallbackPayloadSchema.parse(payload)).toEqual(payload);
    const signed = { ...payload, signature: "signature" };
    expect(discordPublicationStoppedCallbackSchema.parse(signed)).toEqual(signed);
    expect(discordPublicationStoppedCallbackSchema.safeParse(payload).success).toBe(false);
    expect(discordPublicationStoppedCallbackPayloadSchema.safeParse(signed).success).toBe(false);
  });

  it.each([{ channelId }, { channelId, threadId }, { channelId, statusMessage }])(
    "allows absent thread/status coordinates: %j",
    (context) => {
      expect(
        discordPublicationStoppedCallbackPayloadSchema.parse({ ...payload, context }).context
      ).toEqual(context);
    }
  );

  it.each(["source", "repoFullName", "model", "userId", "result", "error", "tool", "args"])(
    "rejects extra %s content at every nesting level",
    (field) => {
      for (const candidate of [
        { ...payload, [field]: "private" },
        { ...payload, context: { ...payload.context, [field]: "private" } },
        {
          ...payload,
          context: {
            ...payload.context,
            statusMessage: { ...payload.context.statusMessage, [field]: "private" },
          },
        },
      ]) {
        expect(discordPublicationStoppedCallbackPayloadSchema.safeParse(candidate).success).toBe(
          false
        );
        expect(
          discordPublicationStoppedCallbackSchema.safeParse({ ...candidate, signature: "sig" })
            .success
        ).toBe(false);
      }
    }
  );

  it.each(["slack.thread_closed", "discord.complete", undefined])(
    "rejects the wrong signed domain: %s",
    (kind) => {
      expect(
        discordPublicationStoppedCallbackSchema.safeParse({ ...payload, kind, signature: "sig" })
          .success
      ).toBe(false);
    }
  );

  it.each([NaN, Infinity, -Infinity, "1700000000000"])(
    "rejects an invalid timestamp: %s",
    (timestamp) => {
      expect(
        discordPublicationStoppedCallbackPayloadSchema.safeParse({ ...payload, timestamp }).success
      ).toBe(false);
    }
  );

  it.each([
    { channelId: " " },
    { ...payload.context, threadId: " " },
    { ...payload.context, statusMessage: { id: " ", startedAt: 1 } },
    { ...payload.context, statusMessage: { ...statusMessage, startedAt: Infinity } },
    { ...payload.context, statusMessage: { id: statusMessage.id } },
  ])("rejects malformed coordinates: %j", (context) => {
    expect(
      discordPublicationStoppedCallbackPayloadSchema.safeParse({ ...payload, context }).success
    ).toBe(false);
  });
});
