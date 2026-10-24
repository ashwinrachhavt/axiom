-- 0243: the task carries why it is on the list (spec: task behaviour
-- includes "rationale"; story: "I can see why I added this task three
-- weeks ago"). Optional and honest: null means none recorded, never a
-- placeholder. Additive nullable column, safe to apply online.
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "rationale" text;
