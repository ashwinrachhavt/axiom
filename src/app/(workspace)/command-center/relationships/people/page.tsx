import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { ImportDialog } from "../import-dialog";
import { RelationshipStatusPill } from "@/components/list/status-pill";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { Screen } from "@/components/workspace/ui";
import { countPeopleByStatus, pagePeople } from "@/domains/identity/party-queries";
import { RELATIONSHIP_STATUSES, RELATIONSHIP_STATUS_LABELS, type RelationshipStatus } from "@/domains/crm/status";
import { getAuthContext } from "@/lib/auth";
import { listHref, offsetFor, parseListParams } from "@/lib/list-params";
import { timeAgo } from "@/lib/time";

export const metadata = { title: "People · Polymath" };

/*
 * The People table over identity-domain records — the rows the LinkedIn CSV
 * import writes. URL state (search, status filter, page) makes a filtered
 * view a shareable link; the list is a plain server render with no client
 * fetching. The status pill is the CRM contact's relationship status matched
 * on the person's primary email; no match reads as Unknown, never guessed.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const BASE = "/command-center/relationships/people";

const STATUS_FILTERS = RELATIONSHIP_STATUSES.map((value) => ({ value, label: RELATIONSHIP_STATUS_LABELS[value] }));

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function avatarTint(id: string): string {
  // Six quiet tints keyed on the id's last hex nibble, so a person keeps the
  // same colour across pages and reloads without another column.
  const tints = [
    "bg-[#E8EEF6] text-[#3B5A7E] dark:bg-[#22303f] dark:text-[#a8c3de]",
    "bg-[#EAF3EC] text-[#3E6B45] dark:bg-[#233024] dark:text-[#a9c8ae]",
    "bg-[#F6EEE2] text-[#7A5A2E] dark:bg-[#332b1e] dark:text-[#d3bd93]",
    "bg-[#F3EAEF] text-[#754760] dark:bg-[#332229] dark:text-[#d0aec0]",
    "bg-[#EDEBF6] text-[#54488E] dark:bg-[#282538] dark:text-[#b4acdc]",
    "bg-[#EAF2F3] text-[#3E6A70] dark:bg-[#20302f] dark:text-[#a2c6c9]",
  ];
  const nibble = parseInt(id.slice(-1), 16);
  return tints[Number.isFinite(nibble) ? nibble % tints.length : 0];
}

async function People({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  await io();
  const auth = await getAuthContext();
  const list = parseListParams(query, { filters: { status: RELATIONSHIP_STATUSES } });
  const status = list.filters.status as RelationshipStatus | undefined;

  const [page, counts] = await Promise.all([
    pagePeople(auth, { query: list.q, limit: list.pageSize, offset: offsetFor(list.page, list.pageSize) }),
    countPeopleByStatus(auth),
  ]);
  redirectPastEnd(BASE, query, list.page, list.pageSize, page.total);

  const countFor = (value: string) =>
    value === "unknown" ? counts.unmatched : counts.statuses.find((s) => s.value === value)?.total ?? 0;

  return (
    <Screen
      title="People"
      actions={
        <ImportDialog>
          <Button variant="outline">Import connections</Button>
        </ImportDialog>
      }
    >
      <ListToolbar
        searchPlaceholder="Search name or email"
        filters={[
          {
            key: "status",
            label: "Status",
            allLabel: "All statuses",
            options: STATUS_FILTERS,
          },
        ]}
      />

      <nav aria-label="People filters" className="flex flex-wrap items-center gap-1">
        <FilterLink href={listHref(BASE, query, { status: undefined, page: undefined })} active={!status} label="All" count={page.total} />
        {STATUS_FILTERS.map((f) => (
          <FilterLink
            key={f.value}
            href={listHref(BASE, query, { status: f.value, page: undefined })}
            active={status === f.value}
            label={f.label}
            count={countFor(f.value)}
          />
        ))}
      </nav>

      <div className="panel min-w-0 overflow-hidden rounded-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="text-muted-foreground px-4 py-2.5 text-left text-xs font-medium">Name</th>
                <th scope="col" className="text-muted-foreground hidden px-4 py-2.5 text-left text-xs font-medium md:table-cell">Company</th>
                <th scope="col" className="text-muted-foreground hidden px-4 py-2.5 text-left text-xs font-medium lg:table-cell">Email</th>
                <th scope="col" className="text-muted-foreground px-4 py-2.5 text-left text-xs font-medium">Status</th>
                <th scope="col" className="text-muted-foreground hidden px-4 py-2.5 text-right text-xs font-medium sm:table-cell">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((person) => (
                <tr key={person.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <span
                        aria-hidden
                        className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${avatarTint(person.id)}`}
                      >
                        {initials(person.displayName)}
                      </span>
                      <div className="min-w-0">
                        {person.crmContactId ? (
                          <Link
                            href={`/command-center/relationships/contacts?id=${person.crmContactId}`}
                            className="block max-w-[16rem] truncate font-medium underline-offset-4 hover:underline"
                          >
                            {person.displayName}
                          </Link>
                        ) : (
                          <span className="block max-w-[16rem] truncate font-medium">{person.displayName}</span>
                        )}
                        {person.title ? (
                          <span className="text-muted-foreground block max-w-[16rem] truncate text-xs">{person.title}</span>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className="text-muted-foreground hidden max-w-[12rem] truncate px-4 py-2.5 md:table-cell">
                    {person.currentOrganizationName ?? "—"}
                  </td>
                  <td className="text-muted-foreground hidden max-w-[14rem] truncate px-4 py-2.5 lg:table-cell">
                    {person.email ?? "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <RelationshipStatusPill status={person.relationshipStatus} />
                  </td>
                  <td className="text-muted-foreground readout hidden px-4 py-2.5 text-right text-xs sm:table-cell">
                    {timeAgo(person.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!page.items.length ? (
          <div className="p-4">
            <NoResults
              filtered={Boolean(list.q || status)}
              clearHref={listHref(BASE, query, { q: undefined, status: undefined, page: undefined })}
              emptyTitle="No people yet"
            />
          </div>
        ) : null}

        <div className="border-t border-border px-4 py-3">
          <Pagination basePath={BASE} raw={query} page={list.page} pageSize={list.pageSize} total={page.total} />
        </div>
      </div>
    </Screen>
  );
}

function FilterLink({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "border-border bg-muted font-medium" : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      {label}
      <span className="readout text-muted-foreground text-xs">{count}</span>
    </Link>
  );
}

export default function PeoplePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading people…</p>}>
      <People searchParams={searchParams} />
    </Suspense>
  );
}
