/**
 * Slack trigger source module.
 */

import type { TriggerSourceDefinition } from "../types";

export {
  normalizeSlackEvent,
  normalizeSlackReaction,
  slackEmojiName,
  buildSlackContextBlock,
  slackChannelLabel,
  SLACK_TEXT_MAX_LENGTH,
} from "./normalizer";
export type {
  SlackMessageAuthor,
  SlackMessageInput,
  SlackChannelMeta,
  SlackReactionInput,
} from "./normalizer";
export {
  slackConditions,
  hasValidSlackChannelCondition,
  hasSlackActorIncludeList,
  normalizeSlackChannelConditions,
  parseSlackChannelCondition,
  REGEX_PATTERN_MAX_LENGTH,
  ALLOWED_REGEX_FLAGS,
} from "./conditions";
export type { SlackChannelConditionParseResult } from "./conditions";

export const slackSource: TriggerSourceDefinition = {
  source: "slack",
  triggerType: "slack_event",
  displayName: "Slack Message",
  description: "Trigger when a message is posted or reacted to in a watched Slack channel",
  // Event types so an automation can wake on reactions instead of messages.
  supportsEventTypes: true,
  eventTypes: [
    {
      eventType: "message.posted",
      displayName: "Message posted",
      description: "A message is posted in a watched channel",
    },
    {
      eventType: "reaction.added",
      displayName: "Reaction added",
      description: "Someone reacts to a message in a watched channel",
    },
  ],
  supportedConditions: ["text_match", "slack_channel", "slack_actor", "slack_reaction"],
};
