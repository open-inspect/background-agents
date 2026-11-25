-- Optional commit status context for PR-event automations. When set, each run posts
-- `pending` on the pull request's head commit as it starts and `success` or `failure`
-- when it finishes, under this context, so branch protection can require the run.
-- NULL posts nothing, which keeps every existing automation's behavior.
ALTER TABLE automations ADD COLUMN commit_status_context TEXT;
