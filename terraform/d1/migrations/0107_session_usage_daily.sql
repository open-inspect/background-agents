-- Session cost per UTC day it was incurred, so analytics can chart spend over
-- time instead of booking a long session's whole cost on the day it started.
-- The Session Durable Object rewrites a session's rows with its index metrics.
-- day_index is epoch milliseconds / 86400000, as analytics buckets created_at.
CREATE TABLE session_usage_daily (
  session_id TEXT NOT NULL,
  day_index  INTEGER NOT NULL,
  cost_usd   REAL NOT NULL CHECK (cost_usd >= 0),
  PRIMARY KEY (session_id, day_index),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_usage_daily_day
  ON session_usage_daily(day_index, session_id);

-- Earlier spend has no per-day record: book it on the session's creation day.
INSERT INTO session_usage_daily (session_id, day_index, cost_usd)
SELECT id, created_at / 86400000, total_cost
FROM sessions
WHERE total_cost > 0;
