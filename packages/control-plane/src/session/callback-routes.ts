import {
  discordCompletionCallbackPayloadSchema,
  discordToolCallCallbackPayloadSchema,
  DISCORD_PUBLICATION_STOPPED_KIND,
  linearCompletionCallbackPayloadSchema,
  linearToolCallCallbackPayloadSchema,
} from "@open-inspect/shared/types/session-api";
import { messageSourceSchema, type MessageSource } from "@open-inspect/shared/types/sessions";
import { z } from "zod";
import type { CallbackDestination } from "../auth/service/callback-signing";
import type { CallbackPublicationScope } from "../authorization/callback-publication-scope";
import { slackPostGate } from "../authorization/slack-post-gate";
import { teamlessPublicationGate } from "../authorization/teamless-publication-gate";

interface CallbackNotification {
  path: string;
  payload: Record<string, unknown>;
}

export interface PreparedCallback {
  payload: Record<string, unknown>;
  postGate(scope: CallbackPublicationScope, sessionId: string): Promise<string | null>;
  denial?: {
    notification(sessionId: string, timestamp: number): CallbackNotification | null;
    failureEvent: string;
  };
}

type CallbackKind = "completion" | "toolCall" | "activity";
type CallbackPreparation =
  | { callback: PreparedCallback; rejectReason?: never }
  | { callback?: never; rejectReason: "invalid_payload" | "invalid_callback_context" };

/** Routing and publication policy only; signing and delivery remain centralized. */
interface CallbackRoute {
  destination: CallbackDestination;
  binding: "SLACK_BOT" | "LINEAR_BOT" | "DISCORD_BOT";
  /** Explicit legacy contract, independent of whether a route validates payloads. */
  defaultArgs?: Record<string, unknown>;
  prepare(kind: CallbackKind, payload: Record<string, unknown>): CallbackPreparation;
}

type ContextualPayload<Context> = Record<string, unknown> & { context: Context };

type RouteDefinition<Context> = Omit<CallbackRoute, "prepare"> & {
  postGate(
    scope: CallbackPublicationScope,
    sessionId: string,
    context: Context
  ): Promise<string | null>;
  denial?: {
    notification(
      sessionId: string,
      context: Context,
      timestamp: number
    ): CallbackNotification | null;
    failureEvent: string;
  };
} & (
    | { contextSchema: z.ZodType<Context> }
    | {
        completionSchema: z.ZodType<ContextualPayload<Context>>;
        toolCallSchema: z.ZodType<ContextualPayload<Context>>;
      }
  );

function defineCallbackRoute<Context>(definition: RouteDefinition<Context>): CallbackRoute {
  return {
    destination: definition.destination,
    binding: definition.binding,
    defaultArgs: definition.defaultArgs,
    prepare(kind, payload) {
      function bindContext(
        context: Context,
        wirePayload: Record<string, unknown>
      ): PreparedCallback {
        const { denial } = definition;
        return {
          payload: wirePayload,
          postGate: (scope, sessionId) => definition.postGate(scope, sessionId, context),
          denial: denial && {
            failureEvent: denial.failureEvent,
            notification: (sessionId, timestamp) =>
              denial.notification(sessionId, context, timestamp),
          },
        };
      }

      if ("contextSchema" in definition) {
        // Legacy Slack payloads still go to the receiver in their original shape.
        const parsed = definition.contextSchema.safeParse(payload.context);
        return parsed.success
          ? { callback: bindContext(parsed.data, payload) }
          : { rejectReason: "invalid_callback_context" };
      }

      if (kind === "activity") {
        return { rejectReason: "invalid_payload" };
      }
      const schema =
        kind === "completion" ? definition.completionSchema : definition.toolCallSchema;
      const parsed = schema.safeParse(payload);
      return parsed.success
        ? { callback: bindContext(parsed.data.context, parsed.data) }
        : { rejectReason: "invalid_payload" };
    },
  };
}

const slackPublicationContextSchema = z.object({
  channel: z.string().min(1),
  threadTs: z.string().min(1).optional().catch(undefined),
});

const SLACK_CALLBACK_ROUTE = defineCallbackRoute({
  destination: "slack-bot",
  binding: "SLACK_BOT",
  contextSchema: slackPublicationContextSchema,
  defaultArgs: {},
  async postGate(scope, sessionId, { channel }) {
    const [session, binding] = await Promise.all([
      scope.getSession(sessionId),
      scope.getChannelBinding(channel),
    ]);
    return slackPostGate(session, binding);
  },
  denial: {
    failureEvent: "callback.thread_closed_delivery_attempt_failed",
    notification(sessionId, { channel, threadTs }, timestamp) {
      if (!threadTs) return null;
      return {
        path: "/callbacks/thread_closed",
        payload: {
          kind: "slack.thread_closed",
          sessionId,
          timestamp,
          context: { channel, threadTs },
        },
      };
    },
  },
});

const CALLBACK_ROUTES: Partial<Record<MessageSource, CallbackRoute>> = {
  slack: SLACK_CALLBACK_ROUTE,
  linear: defineCallbackRoute({
    destination: "linear-bot",
    binding: "LINEAR_BOT",
    completionSchema: linearCompletionCallbackPayloadSchema,
    toolCallSchema: linearToolCallCallbackPayloadSchema,
    // Linear owns its destinations and does not use shared-chat publication scope.
    postGate: async () => null,
  }),
  discord: defineCallbackRoute({
    destination: "discord-bot",
    binding: "DISCORD_BOT",
    completionSchema: discordCompletionCallbackPayloadSchema,
    toolCallSchema: discordToolCallCallbackPayloadSchema,
    postGate: async (scope, sessionId) =>
      teamlessPublicationGate(await scope.getSession(sessionId)),
    denial: {
      failureEvent: "callback.publication_stopped_delivery_attempt_failed",
      notification(sessionId, { channelId, threadId, statusMessage }, timestamp) {
        return {
          path: "/callbacks/publication_stopped",
          payload: {
            kind: DISCORD_PUBLICATION_STOPPED_KIND,
            sessionId,
            timestamp,
            context: { channelId, threadId, statusMessage },
          },
        };
      },
    },
  }),
};

/** Public prompt ingress requires an explicitly owned source. */
export function callbackDestinationForSource(
  source: MessageSource | undefined
): CallbackDestination | undefined {
  return source === undefined ? undefined : CALLBACK_ROUTES[source]?.destination;
}

/** Legacy sources use Slack, including unknown persisted strings and null. */
export function resolveCallbackRoute(source: string | null): CallbackRoute {
  const parsed = messageSourceSchema.safeParse(source);
  return (parsed.success && CALLBACK_ROUTES[parsed.data]) || SLACK_CALLBACK_ROUTE;
}
