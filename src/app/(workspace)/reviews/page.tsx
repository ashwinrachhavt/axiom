import { io } from "next/cache";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { Screen } from "@/components/workspace/ui";
import {
  countPendingProposals,
  listProposalReviews,
  pageReviewQueue,
  REVIEW_QUEUE_STATUSES,
  REVIEW_RISK_CLASSES,
  type ReviewQueueStatus,
  type ReviewRiskClass,
} from "@/domains/actions/queries";
import { listRunAttributions } from "@/domains/agents/queries";
import { getAuthContext } from "@/lib/auth";
import { offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { ReviewsQueue, type QueueCardData } from "./reviews-queue";

export const metadata = { title: "Reviews · Polymath" };

/*
 * The canonical Reviews queue: every external effect an agent wants lands
 * here as a proposal, and the owner's decision binds the exact revision they
 * inspected (CAS on the rendered version, idempotent on the minted key).
 * Approving a capability with a provider executor runs that exact revision
 * once; the attempt, not the proposal, carries the outcome. Calendar changes
 * keep their own one-tap screen and are only decided here. The browser-preview
 * rehearsal stays under /apps/command-center.
 */

const BASE = "/reviews";

/* Past its expiry the executor would refuse the attempt; the card says so. */
function isExpired(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt.getTime() < Date.now();
}

const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All statuses" },
];

const riskLabel: Record<string, string> = {
  read: "Read",
  prepare: "Prepare",
  external_write: "External write",
  sensitive_write: "Sensitive write",
};

async function Reviews({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  await io();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <Screen title="Reviews">
        <EmptyState
          title="Proposal storage is not configured"
          description="Set DATABASE_URL and apply the database migrations to review agent proposals."
        />
      </Screen>
    );
  }
  const auth = await getAuthContext();
  const raw = await searchParams;
  const list = parseListParams(raw, {
    filters: { status: [...REVIEW_QUEUE_STATUSES, "all"], risk: REVIEW_RISK_CLASSES },
    defaultPageSize: 10,
  });
  const status = (list.filters.status ?? "pending") as ReviewQueueStatus | "all";
  const [found, pendingCount] = await Promise.all([
    pageReviewQueue(auth.workspaceId, {
      query: list.q,
      status,
      riskClass: list.filters.risk as ReviewRiskClass | undefined,
      limit: list.pageSize,
      offset: offsetFor(list.page, list.pageSize),
    }),
    countPendingProposals(auth.workspaceId),
  ]);
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);

  const runIds = [...new Set(found.items.map((item) => item.runId).filter((id): id is string => id !== null))];
  const [attributions, reviewsByProposal] = await Promise.all([
    listRunAttributions(auth.workspaceId, runIds),
    listProposalReviews(
      auth.workspaceId,
      found.items.map((item) => item.id),
    ),
  ]);

  const cards: QueueCardData[] = found.items.map((item) => ({
    id: item.id,
    version: item.version,
    title: item.title,
    capability: item.capability,
    riskClass: item.riskClass,
    status: item.status,
    expectedEffect: item.expectedEffect,
    accountAlias: item.accountAlias,
    createdAt: item.createdAt.toISOString(),
    expiresAt: item.expiresAt?.toISOString() ?? null,
    decidedAt: item.decidedAt?.toISOString() ?? null,
    expired: isExpired(item.expiresAt),
    latestRevision: item.latestRevision,
    proposedBy: item.runId ? (attributions.get(item.runId)?.profileName ?? attributions.get(item.runId)?.objective ?? null) : null,
    reviews: (reviewsByProposal.get(item.id) ?? []).map((review) => ({
      id: review.id,
      decision: review.decision,
      note: review.note,
      createdAt: review.createdAt.toISOString(),
    })),
  }));

  const filtered = Boolean(list.q || list.filters.risk || (list.filters.status && list.filters.status !== "pending"));

  return (
    <Screen
      title="Reviews"
      description={`${pendingCount} ${pendingCount === 1 ? "proposal needs" : "proposals need"} your judgment. Approving binds the exact payload you inspected; the card says what happens next.`}
    >
      <ListToolbar
        searchPlaceholder="Search proposals"
        filters={[
          { key: "status", label: "Status", allLabel: "Pending", options: STATUS_OPTIONS },
          {
            key: "risk",
            label: "Risk",
            allLabel: "All risk classes",
            options: REVIEW_RISK_CLASSES.map((value) => ({ value, label: riskLabel[value] ?? value })),
          },
        ]}
        total={found.total}
        noun="proposals"
      />
      {cards.length > 0 ? (
        <ReviewsQueue items={cards} />
      ) : (
        <NoResults
          filtered={filtered}
          clearHref={BASE}
          emptyTitle="Nothing needs your judgment"
          emptyDescription="When an agent wants to change something outside Polymath - send, schedule, post - it proposes the exact payload here first. The queue is empty."
        />
      )}
      <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} />
    </Screen>
  );
}

export default function ReviewsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading the review queue…</p>}>
      <Reviews searchParams={searchParams} />
    </Suspense>
  );
}
