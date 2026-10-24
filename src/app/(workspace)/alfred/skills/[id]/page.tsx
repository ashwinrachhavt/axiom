import Link from "next/link";
import { Suspense } from "react";
import { io } from "next/cache";
import { notFound } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Section } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { getAuthContext } from "@/lib/auth";
import { getSkill } from "@/domains/skills/queries";
import { listRunsForSkill } from "@/domains/agents/queries";
import { RemoveSkillButton, SkillToggle, UseSkill } from "../skill-controls";
import { skillReadiness } from "../readiness";

export const metadata = { title: "Skill · Polymath" };

/*
 * One skill: the exact procedure the assistant is given, the files that
 * travel with it, where it came from, and the runs that pinned it. Provenance
 * reads from the row and from `agent_runs.policy_snapshot`, so removing the
 * skill does not erase the history of what used it.
 */

const stateLabel: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting_input: "Waiting for input",
  waiting_approval: "Waiting for approval",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const installedAt = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

async function SkillSurface({ skillId }: { skillId: string }) {
  await io();
  // A hand-edited URL reaches Postgres as a cast; refuse it here so a bad id is
  // a 404 rather than a database error the person cannot act on.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(skillId)) notFound();
  const auth = await getAuthContext();
  const skill = await getSkill(auth, skillId);
  if (!skill) notFound();

  const runs = await listRunsForSkill(auth.workspaceId, skill.id, 10);
  const readiness = skillReadiness(skill);

  return (
    <div className="flex flex-col">
      <PageHeader
        title={skill.name}
        purpose={skill.description}
        actions={
          <Link
            href="/alfred/skills"
            className="text-muted-foreground text-[13px] underline-offset-4 hover:underline"
          >
            Back to skills
          </Link>
        }
      />
      <div className="flex flex-col gap-6 page-content">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={skill.enabled ? "secondary" : "outline"} className="font-normal">
            {readiness}
          </Badge>
          <Badge variant="outline" className="font-normal">
            {skill.sourceKind}
          </Badge>
          <SkillToggle id={skill.id} name={skill.name} enabled={skill.enabled} />
          <RemoveSkillButton id={skill.id} name={skill.name} />
        </div>

        <Section title="Use this skill" description="The run is pinned to this revision before it starts.">
          <UseSkill id={skill.id} name={skill.name} disabled={!skill.enabled} />
        </Section>

        <Section title="Source">
          <dl className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground text-xs">Source</dt>
            <dd className="break-all">{skill.sourcePath}</dd>
            <dt className="text-muted-foreground text-xs">Ref</dt>
            <dd className="break-all">{skill.sourceRef}</dd>
            <dt className="text-muted-foreground text-xs">Revision</dt>
            <dd className="readout break-all">{skill.revision}</dd>
            <dt className="text-muted-foreground text-xs">Content hash</dt>
            <dd className="readout break-all">{skill.contentHash}</dd>
            <dt className="text-muted-foreground text-xs">Installed</dt>
            <dd>{installedAt.format(skill.createdAt)}</dd>
          </dl>
        </Section>

        {skill.warnings.length > 0 ? (
          <Section title="Warnings" description="Files the inspection could not use. The skill installed without them.">
            <ul className="flex flex-col gap-1">
              {skill.warnings.map((warning) => (
                <li key={warning} className="text-muted-foreground text-[13px]">
                  {warning}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title="Procedure" description="Given to the assistant verbatim. It supplies instructions, not tools.">
          <pre className="panel overflow-x-auto rounded-lg px-3.5 py-3 text-[13px] leading-relaxed whitespace-pre-wrap">
            {skill.body}
          </pre>
        </Section>

        <Section
          title="Files"
          description={skill.files.length === 0 ? "No supporting files." : "Shipped with the procedure."}
        >
          {skill.files.length > 0 ? (
            <ul className="divide-border flex flex-col divide-y rounded-md border border-border">
              {skill.files.map((file) => (
                <li key={file.path} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                  <span className="readout break-all text-[13px]">{file.path}</span>
                  <Readout className="text-muted-foreground text-xs">
                    {new TextEncoder().encode(file.text).byteLength} bytes
                  </Readout>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>

        <Section title="Recent runs" description="Every run that pinned this skill, including ones started before a later edit.">
          {runs.length === 0 ? (
            <p className="text-muted-foreground text-[13px]">
              No runs have used this skill yet. Describe an objective above to start one.
            </p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[13px]">{run.objective}</p>
                    <Badge variant="secondary" className="font-normal">
                      {stateLabel[run.state] ?? run.state}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {run.summary ?? run.error ?? "in progress"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

export default function SkillPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-3 page-content">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      }
    >
      <SkillSurfaceFromParams params={params} />
    </Suspense>
  );
}

async function SkillSurfaceFromParams({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SkillSurface skillId={id} />;
}
