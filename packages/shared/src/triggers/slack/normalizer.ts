/**
 * Normalize raw Slack channel messages into SlackAutomationEvent objects.
 */

import type { SlackAutomationEvent } from "../types";

/** Max length of message text retained for matching + context (characters). */
export const SLACK_TEXT_MAX_LENGTH = 8 * 1024;

/**
 * Who posted a Slack message: a person by `user`, or a bot or integration by
 * `bot_id` alone, even when Slack also reports the app bot's bot user.
 */
export type SlackMessageAuthor =
  { user: string; bot_id?: undefined } | { user?: undefined; bot_id: string };

/** Minimal shape of the Slack `message` event fields the normalizer consumes. */
export type SlackMessageInput = SlackMessageAuthor & {
  channel: string;
  ts: string;
  thread_ts?: string;
  text: string;
};

/** Bot-fetched channel metadata the shared normalizer cannot resolve itself. */
export interface SlackChannelMeta {
  channelName?: string;
  permalink?: string;
}

/** Matches both the bare `<@U…>` and piped `<@U…|display-name>` renderings. */
function botMentionPattern(botUserId: string): RegExp {
  return new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g");
}

/**
 * Compose the context block an agent receives for a Slack-triggered run.
 *
 * Exported because the block is built twice: once at ingress without thread
 * history, and again by the scheduler once a run has actually been admitted and
 * the thread has been fetched. Both go through here so there is one layout and
 * no string surgery to splice history in afterwards.
 *
 * `threadContext` is pre-rendered by slack-bot, which owns the Slack token and
 * display-name resolution.
 */
export function buildSlackContextBlock(params: {
  channelLabel: string;
  actorUserId?: string;
  botId?: string;
  permalink?: string;
  text: string;
  threadContext?: string;
  reaction?: SlackAutomationEvent["reaction"];
}): string {
  // A bot is named by its bot id, which every bot message carries.
  const author = params.botId ? `bot ${params.botId}` : `user ${params.actorUserId}`;
  const messageAuthor = params.reaction?.messageUserId
    ? `user ${params.reaction.messageUserId}`
    : "an app or bot";
  const lines = [
    params.reaction
      ? `In Slack channel ${params.channelLabel}, ${author} reacted with :${params.reaction.name}: to a message by ${messageAuthor}.`
      : `A message was posted in Slack channel ${params.channelLabel} by ${author}.`,
  ];
  if (params.permalink) lines.push(`Permalink: ${params.permalink}`);
  if (params.threadContext) lines.push("", params.threadContext);
  if (params.reaction) lines.push("", "The message they reacted to:");
  lines.push("", "<user_content>", params.text, "</user_content>");
  return lines.join("\n");
}

/** The `#name` form when known, else the raw channel id. */
export function slackChannelLabel(channelId: string, channelName?: string): string {
  return channelName ? `#${channelName}` : channelId;
}

/**
 * Normalize a Slack channel message into a SlackAutomationEvent.
 * Returns null when the message has no usable text (e.g. it is only the bot mention).
 *
 * The caller (slack-bot) supplies `botUserId` so the bot's own mention token is
 * stripped, and `channelMeta` for the human-readable name + permalink the shared
 * package cannot fetch (it has no Slack token). Thread history is not read here:
 * it is fetched lazily, only once a run is admitted (see the scheduler).
 */
export function normalizeSlackEvent(
  input: SlackMessageInput,
  botUserId: string,
  channelMeta?: SlackChannelMeta
): SlackAutomationEvent | null {
  const stripped = (input.text ?? "").replace(botMentionPattern(botUserId), "").trim();
  if (!stripped) return null;

  const text = stripped.slice(0, SLACK_TEXT_MAX_LENGTH);
  const channelLabel = slackChannelLabel(input.channel, channelMeta?.channelName);

  return {
    source: "slack",
    eventType: "message.posted",
    triggerKey: `slack:msg:${input.channel}:${input.ts}`,
    concurrencyKey: `slack:${input.channel}:${input.thread_ts ?? input.ts}`,
    channelId: input.channel,
    channelName: channelMeta?.channelName,
    permalink: channelMeta?.permalink,
    threadTs: input.thread_ts,
    ts: input.ts,
    actorUserId: input.user,
    botId: input.bot_id,
    text,
    contextBlock: buildSlackContextBlock({
      channelLabel,
      actorUserId: input.user,
      botId: input.bot_id,
      permalink: channelMeta?.permalink,
      text,
    }),
    meta: {
      channelId: input.channel,
      ts: input.ts,
      threadTs: input.thread_ts,
      permalink: channelMeta?.permalink,
    },
  };
}

/** The Slack `reaction_added` fields plus the reacted-to message. */
export interface SlackReactionInput {
  channel: string;
  /** The person who reacted. */
  user: string;
  reaction: string;
  eventTs: string;
  message: { ts: string; thread_ts?: string; text: string; user?: string };
}

/** `thumbsup::skin-tone-2` → `thumbsup`. */
export function slackEmojiName(reaction: string): string {
  return reaction.split("::")[0]!;
}

/**
 * Normalize a reaction on a channel message into a `reaction.added`
 * event. The reacted-to message is the event's message, so replies under it
 * become thread context. Returns null when the message has no text.
 */
export function normalizeSlackReaction(
  input: SlackReactionInput,
  channelMeta?: SlackChannelMeta
): SlackAutomationEvent | null {
  const text = input.message.text.trim().slice(0, SLACK_TEXT_MAX_LENGTH);
  if (!text) return null;

  const { channel, message } = input;
  const reaction = {
    name: slackEmojiName(input.reaction),
    eventTs: input.eventTs,
    messageUserId: message.user,
  };
  // A parent message's own thread_ts equals its ts, which still loads its replies.
  const threadTs = message.thread_ts;
  return {
    source: "slack",
    eventType: "reaction.added",
    // One firing per message per automation, whoever reacts and however often.
    triggerKey: `slack:reaction:${channel}:${message.ts}`,
    concurrencyKey: `slack:${channel}:${threadTs ?? message.ts}`,
    channelId: channel,
    channelName: channelMeta?.channelName,
    permalink: channelMeta?.permalink,
    threadTs,
    ts: message.ts,
    actorUserId: input.user,
    text,
    reaction,
    contextBlock: buildSlackContextBlock({
      channelLabel: slackChannelLabel(channel, channelMeta?.channelName),
      actorUserId: input.user,
      permalink: channelMeta?.permalink,
      text,
      reaction,
    }),
    meta: {
      channelId: channel,
      ts: message.ts,
      threadTs,
      permalink: channelMeta?.permalink,
    },
  };
}
