import Link from "next/link";
import { Suspense } from "react";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { getAuthContext } from "@/lib/auth";
import { listSkills } from "@/domains/skills/queries";
import { BUNDLED_SKILLS } from "@/domains/skills/bundled";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, matchesQuery, paginate, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { AddSkillForm } from "./add-skill-form";
import { NewSkill } from "./create-skill";
import { InstallExample, RemoveSkillButton, SkillToggle, UseSkill } from "./skill-controls";
import { READINESS_FILTERS, skillReadiness } from "./readiness";

export const metadata = { title: "Skills · Polymath" };

/*
 * The skills library: procedures the assistant can follow. The page is a
 * library, not an install form - your skills as compact cards, a Discover
 * shelf with the procedures that ship with Polymath, and "New skill" for
 * writing one in plain words. Importing from GitHub or a folder still works,
 * behind one disclosure at the bottom of the library.
 *
 * A skill supplies instructions only; the run's tool scope still comes from
 * its frozen policy, so adding one cannot widen what the assistant may do.
 * Everything on this page reads Neon.
 */

const BASE = "/alfred/skills";

/**
 * Readiness is derived, never stored: a row that exists is Ready unless it has
 * been switched off. The vocabulary is fixed by the ticket (`Ready`,
 * `Disabled`, and the four setup states a later slice can report); the filter
 * offers only the two this slice can produce.
 */
function readinessValue(enabled: boolean): (typeof READINESS_FILTERS)[number] {
  return enabled ? "ready" : "disabled";
}

function shortRevision(revision: string): string {
  return revision.length > 8 ? revision.slice(0, 8) : revision;
}

const installedDate = new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric" });

function sourceLine(skill: { sourceKind: string; sourceRef: string }): string {
  if (skill.sourceKind === "bundled") return "Ships with Polymath";
  if (skill.sourceRef === "authored") return "Written by you";
  return `${skill.sourceKind}: ${skill.sourceRef}`;
}

export async function SkillsSurface({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<RawSearchParams>;
} = {}) {
  await io();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Skills" purpose="Give the assistant a procedure to follow." />
        <div className="page-content">
          <EmptyState
            title="Skill storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to install skills and pin them to runs."
          />
        </div>
      </>
    );
  }

  const auth = await getAuthContext();
  const raw = await searchParams;
  const list = parseListParams(raw, { filters: { readiness: READINESS_FILTERS }, defaultPageSize: 24 });
  const installed = await listSkills(auth);
  const installedIdentities = new Set(installed.map((skill) => `${skill.sourceKind}:${skill.sourcePath}`));
  const tab = (typeof raw.tab === "string" && raw.tab === "discover" ? "discover" : "installed") as "installed" | "discover";

  const matching = installed.filter(
    (skill) =>
      matchesQuery(list.q, skill.name, skill.description, skill.sourceRef) &&
      (!list.filters.readiness || list.filters.readiness === readinessValue(skill.enabled)),
  );
  redirectPastEnd(BASE, raw, list.page, list.pageSize, matching.length);
  const page = paginate(matching, list.page, list.pageSize);
  const filtered = Boolean(list.q || list.filters.readiness);
  const enabledCount = installed.filter((skill) => skill.enabled).length;

  const tabs = (
    <nav aria-label="Skills views" className="flex gap-1">
      {(
        [
          { id: "installed", label: `My skills · ${installed.length}` },
          { id: "discover", label: "Discover" },
        ] as const
      ).map(({ id, label }) => (
        <Link
          key={id}
          href={listHref(BASE, raw, { tab: id === "installed" ? undefined : id, page: undefined })}
          aria-current={tab === id ? "page" : undefined}
          className={`inline-flex min-h-9 items-center rounded-md px-3 text-[13px] font-medium transition-colors ${
            tab === id ? "bg-app-accent text-app-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );

  return (
    <>
      <PageHeader
        title="Skills"
        purpose="Give the assistant a procedure to follow."
        actions={
          <Readout className="text-muted-foreground text-xs">
            {enabledCount} ready of {installed.length}
          </Readout>
        }
      />
      <div className="flex flex-col gap-4 page-content">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {tabs}
          <NewSkill />
        </div>

        {tab === "installed" ? (
          <>
            <ListToolbar
              pageKeys={["page"]}
              searchPlaceholder="Search skills"
              filters={[
                {
                  key: "readiness",
                  label: "Readiness",
                  allLabel: "All skills",
                  options: [
                    { value: "ready", label: "Ready" },
                    { value: "disabled", label: "Disabled" },
                  ],
                },
              ]}
              total={matching.length}
              noun={matching.length === 1 ? "skill" : "skills"}
            />
            {installed.length === 0 ? (
              <EmptyState
                title="No skills yet"
                description="Write one with New skill, or install one from Discover."
              />
            ) : page.items.length === 0 ? (
              <NoResults
                filtered={filtered}
                clearHref={listHref(BASE, raw, { q: undefined, readiness: undefined })}
                emptyTitle=""
                emptyDescription=""
              />
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {page.items.map((skill) => {
                  const readiness = skillReadiness(skill);
                  return (
                    <li key={skill.id} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 flex-col">
                          <Link
                            href={`/alfred/skills/${skill.id}`}
                            className="text-[13px] font-medium underline-offset-4 hover:underline"
                          >
                            {skill.name}
                          </Link>
                          <p className="text-muted-foreground line-clamp-2 text-xs">{skill.description}</p>
                        </div>
                        <Badge variant={skill.enabled ? "secondary" : "outline"} className="shrink-0 font-normal">
                          {readiness}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground readout text-xs">
                        {sourceLine(skill)} · {shortRevision(skill.revision)} · installed {installedDate.format(skill.createdAt)}
                      </p>
                      {skill.warnings.length > 0 ? (
                        <ul className="flex flex-col gap-0.5">
                          {skill.warnings.map((warning) => (
                            <li key={warning} className="text-muted-foreground text-xs">
                              {warning}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                        <UseSkill id={skill.id} name={skill.name} disabled={!skill.enabled} />
                        <SkillToggle id={skill.id} name={skill.name} enabled={skill.enabled} />
                        <RemoveSkillButton id={skill.id} name={skill.name} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <Pagination basePath={BASE} raw={raw} page={page.page} pageSize={list.pageSize} total={page.total} />

            <details className="rounded-xl border border-border">
              <summary className="cursor-pointer list-none px-4 py-3 text-[13px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                Import from GitHub or a folder
              </summary>
              <div className="border-t border-border px-4 py-3">
                <AddSkillForm />
              </div>
            </details>
          </>
        ) : (
          <>
            <p className="text-muted-foreground text-xs">
              Procedures that ship with Polymath. Installing one copies it into your library; it is no different from
              a skill you wrote after that.
            </p>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {BUNDLED_SKILLS.map((skill) => (
                <li key={skill.slug} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
                  <div className="flex min-w-0 flex-col">
                    <p className="text-[13px] font-medium">{skill.name}</p>
                    <p className="text-muted-foreground line-clamp-2 text-xs">{skill.description}</p>
                  </div>
                  <div className="mt-auto pt-1">
                    <InstallExample slug={skill.slug} installed={installedIdentities.has(`bundled:${skill.sourcePath}`)} />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

export default function SkillsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<SkillsSkeleton />}>
      <SkillsSurface searchParams={searchParams} />
    </Suspense>
  );
}

function SkillsSkeleton() {
  return (
    <div role="status" aria-label="Loading Skills" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-40" />
    </div>
  );
}
