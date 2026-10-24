import Link from "next/link";
import { Suspense } from "react";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { getAuthContext } from "@/lib/auth";
import {
  FINISHED_AT,
  STARTED_AT,
  libraryGroup,
  listLibrary,
  readingHistory,
  type LibraryRow,
} from "@/domains/knowledge/reading";

export const metadata = { title: "Library · Polymath" };

/*
 * D18 (ASH-144): the reading library over canonical documents - what to
 * continue, what is unread, what is finished, and the engagement behind it
 * (progress, active minutes, opens). Documents stay managed in Knowledge;
 * this surface is the reading half: quiet text, honest numbers.
 */

const minutes = (seconds: number) => Math.round(seconds / 60);

const openedDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

function progressLabel(row: LibraryRow): string {
  const p = row.state?.furthestProgress ?? 0;
  if (p >= FINISHED_AT) return "Finished";
  if (p >= STARTED_AT) return `${Math.round(p * 100)}%`;
  return row.state ? "Started" : "Not started";
}

function LibraryList({ rows }: { rows: LibraryRow[] }) {
  return (
    <ul className="flex flex-col">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            href={`/alfred/library/${row.id}`}
            className="group flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md px-2 py-2 hover:bg-muted"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium group-hover:underline">
              {row.title}
            </span>
            <span className="text-xs text-muted-foreground">{progressLabel(row)}</span>
            {row.state ? (
              <Readout className="text-xs text-muted-foreground">
                {minutes(row.state.totalActiveSeconds)} min · {row.state.openCount}{" "}
                {row.state.openCount === 1 ? "open" : "opens"} · {openedDate.format(row.state.lastOpenedAt)}
              </Readout>
            ) : (
              <span className="text-xs text-muted-foreground">
                {row.kind === "web_page" ? "Saved page" : row.mimeType ?? "File"}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

async function LibrarySurface() {
  await io();
  const auth = await getAuthContext();
  const [rows, history] = await Promise.all([listLibrary(auth), readingHistory(auth, 10)]);

  if (rows.length === 0) {
    return (
      <div className="page-content">
        <EmptyState
          title="Nothing to read yet"
        />
      </div>
    );
  }

  const groups: Record<ReturnType<typeof libraryGroup>, LibraryRow[]> = { continue: [], unread: [], finished: [] };
  for (const row of rows) groups[libraryGroup(row)].push(row);

  return (
    <div className="flex flex-col gap-8 page-content">
      {groups.continue.length > 0 && (
        <Section title={`Continue reading (${groups.continue.length})`}>
          <LibraryList rows={groups.continue} />
        </Section>
      )}
      <Section title={`Unread (${groups.unread.length})`}>
        {groups.unread.length > 0 ? (
          <LibraryList rows={groups.unread} />
        ) : (
          <p className="text-[13px] text-muted-foreground">Everything added so far has been opened.</p>
        )}
      </Section>
      {groups.finished.length > 0 && (
        <Section title={`Finished (${groups.finished.length})`}>
          <LibraryList rows={groups.finished} />
        </Section>
      )}
      {history.length > 0 && (
        <Section title="Reading history">
          <ul className="flex flex-col gap-1.5">
            {history.map((row) => (
              <li key={row.documentId} className="flex flex-wrap items-baseline gap-x-3 text-[13px]">
                <Link href={`/alfred/library/${row.documentId}`} className="font-medium underline-offset-4 hover:underline">
                  {row.title}
                </Link>
                <span className="text-xs text-muted-foreground">
                  last opened {openedDate.format(row.lastOpenedAt)}
                </span>
                <Readout className="text-xs text-muted-foreground">
                  {minutes(row.totalActiveSeconds)} min total
                </Readout>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

export default function LibraryPage() {
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Library"
      />
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 page-content">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-3/5" />
          </div>
        }
      >
        <LibrarySurface />
      </Suspense>
    </div>
  );
}
