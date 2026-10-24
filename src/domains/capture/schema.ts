import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, tenantId } from "../../db/columns";
import { blobObjects } from "../audit/schema";

/*
 * Capture is deliberately dumb: whatever arrived, exactly as it arrived, plus
 * a processing state. Everything derived from it is a proposal or a converted
 * record that points back here, so the original survives every later edit.
 */

export const captureKind = pgEnum("capture_kind", ["text", "url", "file", "voice", "forwarded"]);
export const captureSource = pgEnum("capture_source", [
  "quick_capture",
  "email",
  "webhook",
  "companion",
  "import",
  "api",
]);
export const captureProcessingState = pgEnum("capture_processing_state", [
  "unprocessed",
  "classifying",
  "enriched",
  "converted",
  "discarded",
  "failed",
]);
export const captureProposalKind = pgEnum("capture_proposal_kind", [
  "task",
  "note",
  "project",
  "contact",
  "company",
  "opportunity",
  "reference",
  "event",
  "discard",
]);
export const captureProposalStatus = pgEnum("capture_proposal_status", [
  "pending",
  "accepted",
  "edited",
  "rejected",
]);

export const captures = pgTable(
  "captures",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    kind: captureKind("kind").notNull(),
    source: captureSource("source").notNull().default("quick_capture"),
    /** The original, immutable. Text bodies, pasted URLs, and transcripts live here. */
    rawPayload: jsonb("raw_payload").notNull(),
    text: text("text"),
    url: text("url"),
    blobId: uuid("blob_id").references(() => blobObjects.id, { onDelete: "set null" }),
    processingState: captureProcessingState("processing_state").notNull().default("unprocessed"),
    /** Suggested by enrichment; never overwrites a person-supplied title. */
    title: text("title"),
    /** Tier 0 output: normalized text. raw_payload stays the immutable original. */
    cleanText: text("clean_text"),
    /** Tier 1 verdict from regex heuristics: prose, code, list, url, log, contact. */
    structure: text("structure"),
    /** Tier 2 LLM reading: one of the capture domains (see classification.ts). */
    domain: text("domain"),
    /** Tier 2 LLM reading: free-form topic tags, capped. */
    tags: jsonb("tags"),
    /** Set once the capture becomes a canonical record; the lineage edge. */
    convertedType: text("converted_type"),
    convertedId: uuid("converted_id"),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    ...mutable,
  },
  (t) => [
    // Partial index: the Inbox queue is the unprocessed rows.
    index("captures_inbox_idx").on(t.workspaceId, t.createdAt).where(sql`processing_state in ('unprocessed', 'classifying')`),
    // Duplicate detection on the provider identity and URL that arrived.
    uniqueIndex("captures_workspace_source_url_key")
      .on(t.workspaceId, t.source, t.url)
      .where(sql`url is not null`),
  ],
);

/*
 * What a model thought the capture was. Never applied silently: a proposal is
 * pending until the owner accepts, edits, or rejects it, and each one carries
 * the model and prompt that produced it plus its own uncertainty.
 */
export const captureProposals = pgTable(
  "capture_proposals",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    captureId: uuid("capture_id")
      .notNull()
      .references(() => captures.id, { onDelete: "cascade" }),
    kind: captureProposalKind("kind").notNull(),
    /** Field values to apply, e.g. { title, dueDate, projectId }. */
    payload: jsonb("payload").notNull(),
    rationale: text("rationale"),
    /** Source offsets into the capture this proposal was derived from. */
    sourceSpans: jsonb("source_spans"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    /** 0–1, as reported by the model. Null when the extraction is rule-based. */
    confidence: text("confidence"),
    status: captureProposalStatus("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by"),
    /** The record this proposal produced, once accepted. */
    resultType: text("result_type"),
    resultId: uuid("result_id"),
    ...mutable,
  },
  (t) => [index("capture_proposals_pending_idx").on(t.workspaceId, t.captureId, t.status)],
);
