import Link from "next/link";
import { Suspense } from "react";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { pageArtifacts } from "@/domains/knowledge/artifacts";
import { getAuthContext } from "@/lib/auth";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";

export const metadata = { title: "Artifacts · Polymath" };

/*
 * The kept-outputs list: everything the assistant generated that this
 * workspace kept. Studio drafts and kept drafts, wiki pages, accepted
 * zettels. Raw saved answers stay in their conversations; human-written
 * pages live in Notes. The query owns the boundary; this page only renders.
 */

const BASE = "/alfred/artifacts";

const KIND_OPTIONS = [
  { value: "report", label: "Reports" },
  { value: "deck", label: "Decks" },
  { value: "infographic", label: "Infographics" },
  { value: "zettel", label: "Zettels" },
  { value: "wiki", label: "Wiki pages" },
];

const STATUS_OPTIONS = [
  { value: "draft", label: "Drafts" },
  { value: "generated", label: "Generated" },
  { value: "reviewed", label: "Kept" },
];

const kindLabel: Record<string, string> = {
  report: "report",
  deck: "deck",
  infographic: "infographic",
  zettel: "zettel",
  note: "wiki page",
};

const statusLabel: Record<string, string> = {
  draft: "draft",
  generated: "generated",
  reviewed: "kept",
};

const stamp = (d: Date) => d.toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The row's kind in the user's vocabulary: wiki pages are stored as notes. */
function rowKind(row: { kind: string; isWiki: boolean }): string {
  if (row.isWiki) return "wiki page";
  return kindLabel[row.kind] ?? row.kind;
}

// Per-request data; streams inside the Suspense boundary in the default export.
export async function ArtifactsSurface({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  await io();
  const auth = await getAuthContext();
  const raw = await searchParams;
  const list = parseListParams(raw, {
    filters: {
      kind: ["report", "deck", "infographic", "zettel", "wiki"],
      status: ["draft", "generated", "reviewed"],
    },
    defaultPageSize: 25,
  });
  const found = await pageArtifacts(auth, {
    kind: list.filters.kind,
    status: list.filters.status,
    query: list.q,
    limit: list.pageSize,
    offset: offsetFor(list.page, list.pageSize),
  });
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);
  const rows = found.items;
  const filtered = Boolean(list.q || list.filters.kind || list.filters.status);
  // The row's destination follows what can open it: a wiki page has a reader,
  // a generated Studio kind opens in the draft workbench, and only the
  // human-written kinds may mount the Notes editor (whose autosave would
  // clobber structured content).
  const hrefFor = (row: { id: string; kind: string; isWiki: boolean }): string => {
    if (row.isWiki) return `/alfred/artifacts/${row.id}`;
    if (kindLabel[row.kind] && row.kind !== "zettel") return `/alfred/dossiers?draft=${row.id}`;
    return `/alfred/notes?id=${row.id}`;
  };

  return (
    <Screen title="Artifacts" description="Everything the assistant generated that you kept.">
      <Panel>
        <div className="mb-3">
          <ListToolbar
            pageKeys={["page"]}
            searchPlaceholder="Search artifacts"
            filters={[
              { key: "kind", label: "Kind", allLabel: "All kinds", options: KIND_OPTIONS },
              { key: "status", label: "Status", allLabel: "All statuses", options: STATUS_OPTIONS },
            ]}
            total={found.total}
            noun={found.total === 1 ? "artifact" : "artifacts"}
          />
        </div>
        {rows.length === 0 ? (
          filtered ? (
            <NoResults
              filtered
              clearHref={listHref(BASE, raw, { q: undefined, kind: undefined, status: undefined, page: undefined })}
              emptyTitle=""
              emptyDescription=""
            />
          ) : (
            <Empty
              title="Nothing here yet."
              description="Generate a report or deck from a Notebook."
              action={
                <Link href="/alfred/dossiers" className="text-[13px] font-medium underline underline-offset-4">
                  Open Notebook
                </Link>
              }
            />
          )
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={hrefFor(row)} className="text-[13px] font-medium underline-offset-4 hover:underline">
                    {row.title}
                  </Link>
                  <span className="flex items-center gap-2">
                    <Status>{rowKind(row)}</Status>
                    <Status>{statusLabel[row.status] ?? row.status}</Status>
                  </span>
                </div>
                {row.excerpt && <p className="line-clamp-2 text-xs text-muted-foreground">{row.excerpt}</p>}
                <p className="text-muted-foreground text-xs">Updated {stamp(row.updatedAt)}</p>
              </li>
            ))}
          </ul>
        )}
        <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} compact />
      </Panel>
    </Screen>
  );
}

export default function ArtifactsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<ArtifactsSkeleton />}>
      <ArtifactsSurface searchParams={searchParams} />
    </Suspense>
  );
}

function ArtifactsSkeleton() {
  return (
    <div role="status" aria-label="Loading Artifacts" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-9 w-full max-w-sm" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-2/3" />
    </div>
  );
}
