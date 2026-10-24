import Link from "next/link";
import { Suspense } from "react";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, Panel, Screen } from "@/components/workspace/ui";
import { listNoteTags } from "@/domains/knowledge/notes";
import { pageZettelCards, type ZettelCardItem } from "@/domains/knowledge/zettels";
import { getAuthContext } from "@/lib/auth";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";

export const metadata = { title: "Zettels · Polymath" };

/*
 * The accepted zettel collection (ASH-184): the same card rows the notebook
 * edits, read through four Alfred-style views - cards, table, timeline and
 * dictionary. Every view is a projection over the artifact store; nothing is
 * copied or denormalized into a view-specific table.
 */

const BASE = "/alfred/knowledge/zettels";
const VIEWS = ["cards", "table", "timeline", "dictionary"] as const;
type View = (typeof VIEWS)[number];

const day = (d: Date) => d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });
const stamp = (d: Date) => d.toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function sortFor(view: View, items: ZettelCardItem[]): ZettelCardItem[] {
  const copy = [...items];
  if (view === "dictionary") copy.sort((a, b) => a.title.localeCompare(b.title));
  if (view === "timeline") copy.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return copy;
}

function SourceLink({ card }: { card: ZettelCardItem }) {
  if (!card.sourceDocumentId) return null;
  return (
    <Link href={`/alfred/knowledge?id=${card.sourceDocumentId}`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
      from {card.sourceTitle ?? "a document"}
    </Link>
  );
}

function TagBadges({ tags, raw }: { tags: string[]; raw: RawSearchParams }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <Link key={t} href={listHref(BASE, raw, { tag: t, page: undefined })} className="rounded-full border border-border px-2 py-0.5 text-[10px] hover:bg-muted/40">
          {t}
        </Link>
      ))}
    </span>
  );
}

function CardsView({ cards, raw }: { cards: ZettelCardItem[]; raw: RawSearchParams }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((card) => (
        <li key={card.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-3 hover:bg-muted/30">
          <Link href={`/alfred/notes?id=${card.id}`} className="text-[13px] font-medium underline-offset-2 hover:underline">
            {card.title}
          </Link>
          {card.excerpt && <p className="line-clamp-3 text-xs text-muted-foreground">{card.excerpt}</p>}
          <span className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
            <TagBadges tags={card.tags} raw={raw} />
            <SourceLink card={card} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function TableView({ cards, raw }: { cards: ZettelCardItem[]; raw: RawSearchParams }) {
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-1.5 pr-3 font-medium">Title</th>
          <th className="py-1.5 pr-3 font-medium">Tags</th>
          <th className="py-1.5 pr-3 font-medium">Source</th>
          <th className="py-1.5 font-medium">Updated</th>
        </tr>
      </thead>
      <tbody>
        {cards.map((card) => (
          <tr key={card.id} className="border-b border-border/60 last:border-0">
            <td className="py-1.5 pr-3">
              <Link href={`/alfred/notes?id=${card.id}`} className="font-medium underline-offset-2 hover:underline">
                {card.title}
              </Link>
            </td>
            <td className="py-1.5 pr-3"><TagBadges tags={card.tags} raw={raw} /></td>
            <td className="py-1.5 pr-3"><SourceLink card={card} /></td>
            <td className="py-1.5 text-xs text-muted-foreground">{stamp(card.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TimelineView({ cards, raw }: { cards: ZettelCardItem[]; raw: RawSearchParams }) {
  const groups = new Map<string, ZettelCardItem[]>();
  for (const card of cards) {
    const key = day(card.createdAt);
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  return (
    <div className="flex flex-col gap-4">
      {[...groups.entries()].map(([when, group]) => (
        <section key={when} aria-label={when}>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{when}</h3>
          <ul className="mt-1.5 flex flex-col gap-1 border-l-2 border-border pl-3">
            {group.map((card) => (
              <li key={card.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <Link href={`/alfred/notes?id=${card.id}`} className="text-[13px] font-medium underline-offset-2 hover:underline">
                  {card.title}
                </Link>
                <TagBadges tags={card.tags} raw={raw} />
                <SourceLink card={card} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function DictionaryView({ cards, raw }: { cards: ZettelCardItem[]; raw: RawSearchParams }) {
  return (
    <dl className="flex flex-col gap-2">
      {cards.map((card) => (
        <div key={card.id} className="rounded-md border border-border px-3 py-2">
          <dt className="flex flex-wrap items-center gap-2">
            <Link href={`/alfred/notes?id=${card.id}`} className="text-[13px] font-medium underline-offset-2 hover:underline">
              {card.title}
            </Link>
            <TagBadges tags={card.tags} raw={raw} />
          </dt>
          {card.excerpt && <dd className="mt-0.5 text-xs text-muted-foreground">{card.excerpt}</dd>}
          <dd className="mt-0.5"><SourceLink card={card} /></dd>
        </div>
      ))}
    </dl>
  );
}

export async function ZettelsSurface({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  await io();
  const auth = await getAuthContext();
  const raw = await searchParams;
  const list = parseListParams(raw, { defaultPageSize: 24 });
  const view: View = (VIEWS as readonly string[]).includes(typeof raw.view === "string" ? raw.view : "") ? (raw.view as View) : "cards";
  const tag = typeof raw.tag === "string" && raw.tag.trim() ? raw.tag.trim().toLowerCase() : undefined;
  const found = await pageZettelCards(auth, { query: list.q, tag, limit: list.pageSize, offset: offsetFor(list.page, list.pageSize) });
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);
  const allTags = await listNoteTags(auth);
  const cards = sortFor(view, found.items);

  return (
    <Screen
      title="Zettels"
      actions={<Link href="/alfred/knowledge" className="text-[13px] text-muted-foreground underline-offset-2 hover:underline">Back to Knowledge</Link>}
    >
      <Panel>
        <div className="mb-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="Zettel views">
          {VIEWS.map((v) => (
            <Link
              key={v}
              role="tab"
              aria-selected={view === v}
              href={listHref(BASE, raw, { view: v === "cards" ? undefined : v, page: undefined })}
              className={`rounded-full border px-3 py-1 text-xs capitalize ${view === v ? "border-foreground/40 bg-muted/70" : "border-border hover:bg-muted/40"}`}
            >
              {v}
            </Link>
          ))}
        </div>
        <div className="mb-3">
          <ListToolbar searchPlaceholder="Search zettels" />
        </div>
        {allTags.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1" aria-label="Filter by tag">
            {allTags.map((t) => (
              <Link
                key={t}
                href={listHref(BASE, raw, { tag: tag === t ? undefined : t, page: undefined })}
                aria-pressed={tag === t}
                className={`rounded-full border px-2 py-0.5 text-xs ${tag === t ? "border-foreground/40 bg-muted/70" : "border-border hover:bg-muted/40"}`}
              >
                {t}
              </Link>
            ))}
          </div>
        )}
        {cards.length === 0 ? (
          list.q || tag ? (
            <NoResults filtered clearHref={listHref(BASE, raw, { q: undefined, tag: undefined, page: undefined })} emptyTitle="" emptyDescription="" />
          ) : (
            <Empty
              title="No zettels yet"
            />
          )
        ) : view === "table" ? (
          <TableView cards={cards} raw={raw} />
        ) : view === "timeline" ? (
          <TimelineView cards={cards} raw={raw} />
        ) : view === "dictionary" ? (
          <DictionaryView cards={cards} raw={raw} />
        ) : (
          <CardsView cards={cards} raw={raw} />
        )}
        <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} compact />
      </Panel>
    </Screen>
  );
}

export default function ZettelsPage(props: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<div role="status" aria-label="Loading Zettels" className="flex flex-1 flex-col gap-4 p-6"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-full max-w-xl" /><Skeleton className="h-40" /></div>}>
      <ZettelsSurface {...props} />
    </Suspense>
  );
}
