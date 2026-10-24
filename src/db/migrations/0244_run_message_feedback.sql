-- 0244: per-message feedback on run threads. The owner's like/dislike on an
-- assistant message, stored on the run event it names. One verdict per event;
-- re-clicking the same value clears it (toggle off). Queryable directly so
-- evaluation can filter runs by feedback without unpacking JSONB.
ALTER TABLE "run_events"
  ADD COLUMN IF NOT EXISTS "feedback" text;
ALTER TABLE "run_events"
  ADD CONSTRAINT "run_events_feedback_check" CHECK ("feedback" IN ('up', 'down'));
