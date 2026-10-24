import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { MAX_UPLOAD_BYTES } from "@/lib/file-validation";
import { sha256Hex } from "@/lib/hash";
import { extractDocument } from "@/domains/knowledge/extraction";
import { intakeFile } from "@/domains/knowledge/intake";
import { documents } from "@/domains/knowledge/schema";
import { recordSource } from "@/domains/knowledge/sources";
import { THREAD_CHANGED_TOPIC, threadChangedHandler } from "@/domains/knowledge/thread-graph";
import { youtubeHandlers } from "@/domains/knowledge/youtube-handler";
import { urlContentRequestedHandler } from "@/domains/capture/url-content-handler";
import { CAPTURE_ENRICHMENT_TOPIC, CAPTURE_URL_CONTENT_TOPIC } from "@/domains/capture/commands";
import { captureEnrichmentRequestedHandler } from "@/domains/capture/enrichment-handler";
import { isTerminalCrawlStatus, pollCrawl, submitCrawl } from "@/integrations/firecrawl/client";
import { memberships } from "@/domains/identity/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { OutboxParkError, updateOutboxPayload, type ClaimedOutboxEvent, type OutboxHandler } from "./outbox";

/*
 * Consumers for the outbox dispatcher (ASH-134 Q03). Intake queues
 * `document.extraction_requested` in the same transaction as the upload; this
 * is the first consumer that turns it into work. Delivery is at-least-once, so
 * the handler leans on extractDocument's own claim: a succeeded extraction for
 * the same content hash returns deduplicated instead of calling the provider.
 */

/** The actor for background work: the workspace's earliest active owner. Null when none exists. */
export async function workspaceOwnerAuth(workspaceId: string): Promise<AuthContext | null> {
  const [row] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(
      eq(memberships.workspaceId, workspaceId),
      eq(memberships.role, "owner"),
      eq(memberships.status, "active"),
    ))
    .orderBy(asc(memberships.createdAt))
    .limit(1);
  return row ? { userId: row.userId, workspaceId, role: "owner" } : null;
}

export const extractionRequestedHandler: OutboxHandler = async (event) => {
  const payload = event.payload as { documentId?: unknown } | null;
  const documentId = typeof payload?.documentId === "string" ? payload.documentId : null;
  // A malformed or fileless intent can never succeed; completing it avoids
  // five pointless retries before dead-lettering.
  if (!documentId) return;
  const auth = await workspaceOwnerAuth(event.workspaceId);
  if (!auth) throw new Error("workspace has no active owner to act for the extraction");
  const result = await extractDocument(auth, { documentId });
  // `in_progress` elsewhere throws nothing; a provider failure is recorded on
  // the extraction row and is retried by redelivery, so surface it.
  if (!result.ok) throw new Error(result.error);
};

/*
 * A crawl is three passes over the same row, never one long request:
 *
 *   pass 1  no jobId      -> submit to Firecrawl, park the row with the jobId
 *   pass n  jobId, running -> park again, backing off as attempts accumulate
 *   last    jobId, terminal-> write every page as a document + a source row
 *
 * Parking is a payload update, not a failure: the row keeps its attempt count,
 * so a crawl that takes four minutes is one attempt, not forty-eight.
 *
 * Delivery is at-least-once. Every write below is idempotent on its own key -
 * intakeFile attaches to an existing document, and `sources` has a partial
 * unique index on (workspace, url, content_hash) - so a reclaimed row re-runs
 * to the same state.
 */

export const CRAWL_TOPIC = "crawl.requested";

type CrawlPayload = {
  url?: unknown;
  limit?: unknown;
  maxDepth?: unknown;
  request?: unknown;
  jobId?: unknown;
  startedAt?: unknown;
  /** Passes spent waiting on the provider. Survives across parks, unlike attempts. */
  polls?: unknown;
};

const CRAWL_POLL_BASE_MS = 5_000;
const CRAWL_POLL_MAX_MS = 30_000;

/**
 * Back off between polls so a slow crawl does not hammer the status endpoint.
 *
 * Driven by a counter in the payload, not by `attempts`: a parked row spends no
 * attempt (that is the point), so `attempts` stays 0 forever and a backoff keyed
 * on it would never grow.
 */
function nextPollMs(polls: number): number {
  return Math.min(CRAWL_POLL_MAX_MS, CRAWL_POLL_BASE_MS * 2 ** Math.min(3, Math.max(0, polls - 1)));
}

/** A Firecrawl job nobody has settled is abandoned rather than polled forever. */
const CRAWL_MAX_AGE_MS = 30 * 60_000;

function isProviderDown(cause: unknown): boolean {
  // fetch() rejects with a TypeError when it cannot connect at all.
  return cause instanceof TypeError;
}

export const crawlRequestedHandler: OutboxHandler = async (event: ClaimedOutboxEvent) => {
    const raw = event.payload ?? {};
    // A payload that is not an object was never written by this handler's
    // producer. Failing loudly beats completing silently with nothing done -
    // that is how a double-encoded row would have dispatched as success.
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`crawl.requested has a malformed payload (${typeof raw}); redeploy the producer`);
    }
    const payload = raw as CrawlPayload;
    const url = typeof payload.url === "string" ? payload.url : null;
    if (!url) throw new Error("crawl.requested has no url");

    const limit = typeof payload.limit === "number" ? payload.limit : 10;
    const maxDepth = typeof payload.maxDepth === "number" ? payload.maxDepth : 1;
    const jobId = typeof payload.jobId === "string" ? payload.jobId : null;

    // Pass 1: no provider job yet.
    if (!jobId) {
      let submitted: { jobId: string };
      try {
        submitted = await submitCrawl(url, { limit, maxDepth });
      } catch (cause) {
        if (isProviderDown(cause)) throw new OutboxParkError(60_000, "Firecrawl is unreachable");
        throw cause;
      }
      await updateOutboxPayload({
        id: event.id,
        leaseToken: event.leaseToken,
        payload: { ...payload, jobId: submitted.jobId, startedAt: new Date().toISOString() },
      });
      throw new OutboxParkError(CRAWL_POLL_BASE_MS, "crawl submitted, awaiting pages");
    }

    // Pass n: read the job. A status endpoint that cannot answer is deferred,
    // not failed - the crawl may still be running perfectly well.
    let poll;
    try {
      poll = await pollCrawl(jobId);
    } catch (cause) {
      if (isProviderDown(cause)) throw new OutboxParkError(60_000, "Firecrawl is unreachable");
      throw cause;
    }

    const startedAt = typeof payload.startedAt === "string" ? Date.parse(payload.startedAt) : null;
    const abandoned = startedAt !== null && Date.now() - startedAt > CRAWL_MAX_AGE_MS;

    const polls = typeof payload.polls === "number" ? payload.polls : 0;
    if (!isTerminalCrawlStatus(poll.status) && !abandoned) {
      await updateOutboxPayload({
        id: event.id,
        leaseToken: event.leaseToken,
        payload: { ...payload, polls: polls + 1 },
      });
      throw new OutboxParkError(nextPollMs(polls + 1), `crawl still ${poll.status}`);
    }

    if (poll.status === "failed" || poll.status === "cancelled" || abandoned) {
      // A real failure is a spent attempt with backoff; dead after the ceiling.
      throw new Error(
        abandoned
          ? `crawl did not finish within ${Math.round(CRAWL_MAX_AGE_MS / 60_000)} minutes`
          : poll.error ?? "crawl failed",
      );
    }

    const auth = await workspaceOwnerAuth(event.workspaceId);
    if (!auth) throw new Error("workspace has no active owner to receive the crawled pages");
    const outcome = await landCrawlPages(auth, { jobId, pages: poll.pages });
    // A completed crawl whose pages all failed to file is not a success. Retry
    // it: the alternative is a dispatched row, an empty library, and a person
    // who was told the site had been captured.
    if (outcome.failed > 0 && outcome.landed === 0) {
      throw new Error(`crawl completed but none of its ${outcome.failed} page(s) could be filed`);
    }
  };


/**
 * Every page becomes a document, and every page becomes a source row.
 *
 * Documents are the readable record; `sources` is the citation identity that
 * claims and dossiers point at. A crawl that wrote only one or only the other
 * would leave the page either unreadable or uncitable. Both writes are
 * idempotent, so a redelivered event converges instead of duplicating.
 */
async function landCrawlPages(
  auth: AuthContext,
  input: { jobId: string; pages: Array<{ url: string; markdown: string; title: string | null }> },
): Promise<{ landed: number; failed: number }> {
  const seen = new Set<string>();
  let landed = 0;
  let failed = 0;
  for (const page of input.pages) {
    const trimmed = page.markdown.trim();
    // A page with no readable text is not a library record; skip it rather than
    // filing an empty document the owner has to clean up.
    if (!trimmed) continue;
    let parsed: URL;
    try {
      parsed = new URL(page.url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const sourceUrl = parsed.href;
    if (seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);

    // At-least-once delivery: this event may be redelivered after it already
    // filed these pages. `documents` holds one row per (workspace, source_url),
    // so a second intake would violate that index and dead-letter the crawl.
    // Checking first is what makes the handler idempotent.
    const [existing] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.workspaceId, auth.workspaceId), eq(documents.sourceUrl, sourceUrl)))
      .limit(1);
    if (existing) continue;

    const bytes = new TextEncoder().encode(trimmed);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) continue;
    const contentHash = await sha256Hex(bytes);
    const title = (page.title ?? parsed.hostname).slice(0, 200);

    try {
      await intakeFile(auth, {
        bytes,
        filename: `${safeSlug(parsed)}.md`,
        title,
        verdict: { ok: true, mimeType: "text/markdown" },
        contentHash,
        origin: "crawl",
        sourceUrl,
        inTransaction: (tx) =>
          recordSource(auth, tx, {
            title,
            url: sourceUrl,
            contentHash,
            kind: "web",
            providerRequestId: input.jobId,
          }),
      });
      landed += 1;
    } catch (cause) {
      // One page failing is not the crawl failing. The rest still land, and the
      // page's absence is visible as a shorter library rather than an error.
      failed += 1;
      console.warn(`crawl ${input.jobId}: could not file ${sourceUrl}:`, cause instanceof Error ? cause.message : cause);
    }
  }
  return { landed, failed };
}

function safeSlug(url: URL): string {
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  const base = (last.replace(/\.[^.]+$/, "") || url.hostname).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return (base || "page").slice(0, 80);
}

/*
 * Built on first use, not at module evaluation.
 *
 * `youtube-handler.ts` imports `workspaceOwnerAuth` from this file, so spreading
 * `youtubeHandlers` into an eagerly-evaluated object is a cycle: whichever module
 * loads second reads the other's binding while it is still uninitialised
 * ("Cannot access 'youtubeHandlers' before initialization"). Deferring the spread
 * to the first dispatch costs one call and removes the ordering dependency
 * entirely.
 */
let handlers: Record<string, OutboxHandler> | null = null;

export function outboxHandlers(): Record<string, OutboxHandler> {
  if (handlers) return handlers;
  handlers = {
    "document.extraction_requested": extractionRequestedHandler,
    [CRAWL_TOPIC]: crawlRequestedHandler,
    ...youtubeHandlers,
    [THREAD_CHANGED_TOPIC]: threadChangedHandler(workspaceOwnerAuth),
    [CAPTURE_URL_CONTENT_TOPIC]: urlContentRequestedHandler,
    [CAPTURE_ENRICHMENT_TOPIC]: captureEnrichmentRequestedHandler,
  };
  return handlers;
}
