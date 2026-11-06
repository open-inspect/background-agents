-- Slack automations now pick an event type (message.posted or
-- reaction.added). Every Slack automation created before then fired on messages.
UPDATE automations
   SET event_type = 'message.posted'
 WHERE trigger_type = 'slack_event' AND event_type IS NULL;
