-- Let a GitHub event automation replace its run in flight instead of skipping
-- the new event.
--
-- An event firing is admitted only when the automation has no active run for
-- the event's concurrency key (for a pull request event, the pull request).
-- With cancel_in_progress set, a firing that finds one ends it instead: the
-- active run is marked skipped with skip_reason 'superseded', its session is
-- asked to cancel, and the new firing starts. It mirrors GitHub Actions'
-- concurrency.cancel-in-progress.
--
-- The default of 0 keeps the existing skip behaviour for every automation.
ALTER TABLE automations ADD COLUMN cancel_in_progress INTEGER NOT NULL DEFAULT 0
  CHECK (cancel_in_progress IN (0, 1));
