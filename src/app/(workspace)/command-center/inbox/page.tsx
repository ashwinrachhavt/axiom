import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { cn } from "cn";
import { Pagination } from "@/components/list/pagination";
import { ListToolbar } from "@/components/list/list-toolbar";
import { redirectPastEnd } from "@/components/list/clamp";
import { CAPTURE_KINDS, type InboxFilter } from "@/domains/capture/queries";
import { countInboxTabsForPage, getCaptureForPage, searchCapturesForPage } from "./data";
import { listHref, offsetFor, parseListParams } from "@/lib/list-params";
import { getAuthContext } from "@/lib/auth";
import { CaptureForm } from "./inbox-client";
import { InboxList } from "./inbox-list";
import { InboxDetail } from "./inbox-detail";

export const metadata = { title: "Inbox · Polymath" };

/*
 * The durable inbox (ASH-137 A02, two panes as of 2026-10-20): the list shows
 * one clamped line per capture and bulk select; the detail pane is a
 * server-rendered view of the same captures row, selected by ?id=. URL is the
 * state, so back/forward and refresh hold the selection. Nothing is classified
 * or converted by a model on this page.
 *
 * The screen has no page title above the panes. The list column owns its
 * header (title, count, composer, filters) and the detail column owns its own
 * scroll, so the list starts at the top of the viewport rather than under a
 * heading that only repeats the breadcrumb.
 */

const filters: Array<{ value: InboxFilter; label: string }> = [
  { value: "unprocessed", label: "To clarify" },
  { value: "converted", label: "Converted" },
  { value: "discarded", label: "Archived" },
  { value: "all", label: "All" },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function Inbox({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const list = parseListParams(query, { filters: { kind: CAPTURE_KINDS } });
  const raw = typeof query.filter === "string" ? query.filter : "unprocessed";
  const filter: InboxFilter = filters.some((f) => f.value === raw) ? (raw as InboxFilter) : "unprocessed";
  // A malformed id (or a non-uuid string) would make Postgres reject the
  // uuid comparison with 22P02 and crash the screen; treat it as no
  // selection, matching the valid-but-unknown id path.
  const rawId = typeof query.id === "string" ? query.id : null;
  const selectedId = rawId && UUID.test(rawId) ? rawId : null;
  await io();
  const auth = await getAuthContext();
  const kind = list.filters.kind as (typeof CAPTURE_KINDS)[number] | undefined;
  const [found, tabs, selected] = await Promise.all([
    searchCapturesForPage(auth, {
      filter,
      kind,
      query: list.q,
      limit: list.pageSize,
      offset: offsetFor(list.page, list.pageSize),
    }),
    countInboxTabsForPage(auth),
    // The detail pane is a view of the record, not of the current filter: a
    // capture outside the view still renders, the list just shows no highlight.
    selectedId ? getCaptureForPage(auth, selectedId) : Promise.resolve(null),
  ]);
  const rows = found.items;
  const pageSize = list.pageSize;
  redirectPastEnd("/command-center/inbox", query, list.page, pageSize, found.total);
  const page = list.page;
  const filtered = Boolean(list.q || list.filters.kind);
  const clearHref = listHref("/command-center/inbox", query, { q: undefined, kind: undefined, page: 1 });

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col overflow-hidden max-md:h-auto max-md:overflow-visible">
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,520px)_minmax(0,1fr)]">
        <section
          aria-label="Capture queue"
          className="flex min-h-0 min-w-0 flex-col border-border max-md:min-h-[70dvh] md:border-r"
        >
          <header className="shrink-0 border-border border-b px-3 pt-2.5 pb-3">
            <div className="flex h-8 items-center gap-2">
              <h1 className="text-[13px] font-medium tracking-tight">Inbox</h1>
              <span className="readout text-xs text-muted-foreground">{tabs.unprocessed} to clarify</span>
            </div>
            <div className="mt-1">
              <CaptureForm />
            </div>
          </header>

          <div className="shrink-0 space-y-2.5 border-border border-b px-3 py-2.5">
            {/* Segmented filter: the active state is a raised surface, not an
                underline, so the row reads as one control rather than links. */}
            <nav aria-label="Inbox filters">
              <ul className="inline-flex h-8 items-center gap-0.5 rounded-lg bg-muted p-[3px]">
                {filters.map((f) => {
                  const active = f.value === filter;
                  return (
                    <li key={f.value}>
                      <Link
                        href={listHref("/command-center/inbox", query, {
                          filter: f.value === "unprocessed" ? undefined : f.value,
                          page: 1,
                        })}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "bg-background font-medium text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {f.label}
                        {/* Decoration on the link's name: without aria-hidden the
                            accessible name becomes "Converted 3" and the tab
                            stops being addressable as "Converted". */}
                        <span aria-hidden="true" className="readout tabular-nums opacity-70">
                          {tabs[f.value]}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <ListToolbar
              searchPlaceholder="Search captures"
              filters={[
                {
                  key: "kind",
                  label: "Type",
                  allLabel: "All types",
                  options: CAPTURE_KINDS.map((k) => ({ value: k, label: k[0]!.toUpperCase() + k.slice(1) })),
                },
              ]}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <InboxList
              view={filter}
              selectedId={selectedId}
              rawQuery={query}
              rows={rows.map((capture) => ({
                id: capture.id,
                processingState: capture.processingState,
                kind: capture.kind,
                createdAt: capture.createdAt.toISOString(),
                preview: capture.preview,
                url: capture.url,
                version: capture.version,
                convertedType: capture.convertedType,
                convertedId: capture.convertedId,
              }))}
            />

            {!rows.length ? (
              <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
                <p className="text-[13px]">{filtered ? "No matches" : "Nothing in this view"}</p>
                <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                  {filtered ? "Nothing fits the current search and filters." : "Capture material above or choose another filter."}
                </p>
                {filtered ? (
                  <Link href={clearHref} className="mt-1 text-[13px] font-medium underline underline-offset-4">
                    Clear filters
                  </Link>
                ) : null}
              </div>
            ) : null}

            <div className="px-3 pb-3">
              <Pagination basePath="/command-center/inbox" raw={query} page={page} pageSize={pageSize} total={found.total} />
            </div>
          </div>
        </section>

        <section
          aria-label="Capture detail"
          className="min-w-0 overflow-y-auto border-border px-5 py-6 max-md:min-h-[50dvh] md:px-10 md:py-10"
        >
          <InboxDetail
            capture={
              selected
                ? {
                    id: selected.id,
                    processingState: selected.processingState,
                    kind: selected.kind,
                    createdAt: selected.createdAt.toISOString(),
                    text: selected.text,
                    url: selected.url,
                    rawPayload: selected.rawPayload,
                    version: selected.version,
                    failureReason: selected.failureReason,
                    convertedType: selected.convertedType,
                    convertedId: selected.convertedId,
                  }
                : null
            }
          />
        </section>
      </div>
    </div>
  );
}

export default function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening the inbox…</p>}>
      <Inbox searchParams={searchParams} />
    </Suspense>
  );
}
