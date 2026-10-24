import Link from "next/link";
import { Suspense } from "react";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { cardHeaderStats, listCardSources, pageCards, type CardStateFilter } from "@/domains/knowledge/card-queries";
import { getPreferences } from "@/domains/identity/preferences";
import { getAuthContext } from "@/lib/auth";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { CardControls, NewCardForm } from "./card-controls";

export const metadata = { title: "Cards · Polymath" };

/*
 * Zettel cards and recall (Product Spec): proposed cards wait for acceptance,
 * scheduled cards wait in the review queue, and every card cites the note or
 * zettel it came from. The review itself lives at ./review - one card at a
 * time, answer hidden until attempted.
 */

const BASE = "/alfred/knowledge/cards";
const STATES = ["proposed", "scheduled", "suspended", "retired", "all"] as const;

/*
 * due_at is an instant (timestamptz); the scheduler moves it by minutes
 * (a miss: +10) or whole days (a hit: the SM-2 ladder). What is "due" is
 * therefore instant-based - not calendar-day-based - while this label is
 * the day that instant lands on in the owner's saved timezone.
 */
const dayIn = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone }).format(d);

function stateLabel(item: { state: string; lastOutcome: string | null }): string {
  if (item.state === "scheduled" && item.lastOutcome) return item.lastOutcome === "correct" ? "answered correctly" : "answered wrong";
  return item.state;
}

async function CardsSurface({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  await io();
  const auth = await getAuthContext();
  const raw = await searchParams;
  const list = parseListParams(raw, { defaultPageSize: 24 });
  const state: CardStateFilter = (STATES as readonly string[]).includes(typeof raw.state === "string" ? raw.state : "")
    ? (raw.state as CardStateFilter)
    : "proposed";
  const [stats, found, sources, { timezone }] = await Promise.all([
    cardHeaderStats(auth),
    pageCards(auth, { state, query: list.q, limit: list.pageSize, offset: offsetFor(list.page, list.pageSize) }),
    listCardSources(auth),
    getPreferences(auth),
  ]);
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);

  return (
    <Screen
      title="Cards"
      actions={
        <Link href="/alfred/knowledge" className="text-[13px] text-muted-foreground underline-offset-2 hover:underline">
          Back to Knowledge
        </Link>
      }
    >
      <Panel>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
          <span>
            <strong className="font-medium">{stats.due}</strong> due
          </span>
          <span>
            <strong className="font-medium">{stats.proposed}</strong> proposed
          </span>
          {stats.reviews > 0 && (
            <span className="text-muted-foreground">
              {stats.correct} of {stats.reviews} recalled
            </span>
          )}
          {stats.due > 0 && (
            <Link href={`${BASE}/review`} className="font-medium underline-offset-2 hover:underline">
              Review now
            </Link>
          )}
        </div>
      </Panel>

      <Panel title="New card" description="A card cites its source; it enters review only after you accept it.">
        <NewCardForm sources={sources} />
      </Panel>

      <Panel>
        <div className="mb-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="Card states">
          {STATES.map((s) => (
            <Link
              key={s}
              role="tab"
              aria-selected={state === s}
              href={listHref(BASE, raw, { state: s === "proposed" ? undefined : s, page: undefined })}
              className={`rounded-full border px-3 py-1 text-xs capitalize ${state === s ? "border-foreground/40 bg-muted/70" : "border-border hover:bg-muted/40"}`}
            >
              {s}
            </Link>
          ))}
        </div>
        <div className="mb-3">
          <ListToolbar searchPlaceholder="Search cards" />
        </div>
        {found.items.length === 0 ? (
          list.q ? (
            <NoResults filtered clearHref={listHref(BASE, raw, { q: undefined, page: undefined })} emptyTitle="" emptyDescription="" />
          ) : (
            <Empty title={state === "proposed" ? "No proposed cards" : `No ${state} cards`} />
          )
        ) : (
          <ul className="flex flex-col gap-2">
            {found.items.map((card) => (
              <li key={card.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-[13px] font-medium">{card.prompt}</p>
                  <Status>{stateLabel(card)}</Status>
                </div>
                {/* Acceptance inspects what enters circulation: the answer is
                    part of the row, not hidden behind the Accept click. */}
                <p className="text-[13px] leading-relaxed text-muted-foreground">{card.answer}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {card.sourceId && !card.sourceArchived ? (
                    <Link href={`/alfred/notes?id=${card.sourceId}`} className="underline-offset-2 hover:underline">
                      from {card.sourceTitle}
                    </Link>
                  ) : (
                    <span>
                      from {card.sourceTitle} ({card.sourceId ? "source archived" : "source deleted"})
                    </span>
                  )}
                  {card.state === "scheduled" && card.dueAt && <span>due {dayIn(card.dueAt, timezone)}</span>}
                  {card.reviewCount > 0 && (
                    <span>
                      {card.correctCount}/{card.reviewCount} recalled
                    </span>
                  )}
                </div>
                <CardControls cardId={card.id} expectedVersion={card.version} state={card.state} />
              </li>
            ))}
          </ul>
        )}
        <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} compact />
      </Panel>
    </Screen>
  );
}

export default function CardsPage(props: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-label="Loading Cards" className="flex flex-1 flex-col gap-4 p-6">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full max-w-xl" />
          <Skeleton className="h-40" />
        </div>
      }
    >
      <CardsSurface {...props} />
    </Suspense>
  );
}
