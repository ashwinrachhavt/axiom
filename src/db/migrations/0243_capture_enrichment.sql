-- 0243: capture enrichment columns. The classifier ladder (capture.enrichment_requested)
-- writes structured signal here so every later tier starts from signal, not raw payload:
-- cleaned text, a structure verdict from regex heuristics, and the LLM's topic/domain
-- reading. Enrichment is additive signal on the capture, never a rewrite of raw_payload.
ALTER TABLE "captures"
  ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "captures"
  ADD COLUMN IF NOT EXISTS "clean_text" text;
ALTER TABLE "captures"
  ADD COLUMN IF NOT EXISTS "structure" text;
ALTER TABLE "captures"
  ADD COLUMN IF NOT EXISTS "domain" text;
ALTER TABLE "captures"
  ADD COLUMN IF NOT EXISTS "tags" jsonb;
