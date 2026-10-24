import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { type BriefingTask } from "@/domains/work/briefing";
import { getBriefingForPage } from "./data";
import { getAuthContext } from "@/lib/auth";
import { AgentPanels } from "./agent-panels";
import { CalendarPanel } from "./calendar-panel";
import { OutcomeButton, StartFocusButton } from "./briefing-client";

export const metadata = { title: "Briefing · Polymath" };

/*
 * The durable Briefing (ASH-137 A01): three outcomes, today's queue and the
 * waiting list all read the canonical tasks table. Accepting an outcome is a
 * version-checked tag on the task - nothing here schedules, calls a model,
 * or touches a connector. The browser-preview briefing with its local
 * agenda, stones and activity panels stays at /apps/command-center/briefing.
 */

function TaskRow({ task, outcomeTag, mode }: { task: BriefingTask; outcomeTag: string; mode: "accept" | "replace" }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
      <div>
        <Link href={`/neuralflow/work?task=${encodeURIComponent(task.id)}`} className="text-[13px] font-medium hover:underline">
          {task.title}
        </Link>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {task.status.replaceAll("_", " ")}
          {task.dueAt ? ` · due ${task.dueAt.toISOString().slice(0, 10)}` : " · no deadline"} · {task.priority} priority
        </p>
      </div>
      <div className="flex items-center gap-2">
        {mode === "replace" ? <Status>Accepted outcome</Status> : <Status>Suggested</Status>}
        <StartFocusButton task={{ id: task.id, title: task.title }} />
        <OutcomeButton taskId={task.id} version={task.version} tags={task.tags} outcomeTag={outcomeTag} mode={mode} />
      </div>
    </div>
  );
}

async function Briefing() {
  await io();
  const auth = await getAuthContext();
  const briefing = await getBriefingForPage(auth);
  const outcomeTag = `Outcome:${briefing.today}`;

  return (
    <Screen
      title="Briefing"
      actions={
        <>
          <Button variant="outline" size="sm" asChild><Link href="/command-center/inbox">Clarify inbox</Link></Button>
          <Button variant="outline" size="sm" asChild><Link href="/neuralflow/work">Open Work</Link></Button>
        </>
      }
    >
      <Panel
        title="Three outcomes"
        description="Accepting tags the canonical task for this day; it does not schedule or start work."
      >
        <div className="divide-y divide-border">
          {briefing.outcomes.map((task) => <TaskRow key={task.id} task={task} outcomeTag={outcomeTag} mode="replace" />)}
          {briefing.suggested.map((task) => <TaskRow key={task.id} task={task} outcomeTag={outcomeTag} mode="accept" />)}
        </div>
        {!briefing.outcomes.length && !briefing.suggested.length ? (
          <Empty
            title="No open outcome candidates"
            action={<Button size="sm" asChild><Link href="/neuralflow/work">Create a commitment</Link></Button>}
          />
        ) : null}
      </Panel>

      <Suspense fallback={<p role="status" className="text-[13px] text-muted-foreground">Checking the calendar…</p>}>
        <CalendarPanel />
      </Suspense>

      <Suspense fallback={<p role="status" className="text-[13px] text-muted-foreground">Checking the agents…</p>}>
        <AgentPanels />
      </Suspense>

      {briefing.dueTodayOrOverdue.length || briefing.waiting.length ? (
        <div className="grid items-start gap-6 xl:grid-cols-2">
          {briefing.dueTodayOrOverdue.length ? (
            <Panel title="Today and overdue">
              <div className="divide-y divide-border">
                {briefing.dueTodayOrOverdue.map((task) => (
                  <div key={task.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                    <div>
                      <Link href={`/neuralflow/work?task=${encodeURIComponent(task.id)}`} className="text-[13px] font-medium hover:underline">
                        {task.title}
                      </Link>
                      <p className="mt-0.5 text-xs text-muted-foreground">due {task.dueAt?.toISOString().slice(0, 10)} · {task.priority} priority</p>
                    </div>
                    <StartFocusButton task={{ id: task.id, title: task.title }} />
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}
          {briefing.waiting.length ? (
            <Panel title="Waiting commitments">
              <div className="divide-y divide-border">
                {briefing.waiting.map((task) => (
                  <div key={task.id} className="py-3 first:pt-0">
                    <Link href={`/neuralflow/work?task=${encodeURIComponent(task.id)}`} className="text-[13px] font-medium hover:underline">
                      {task.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      waiting{task.dueAt ? ` · due ${task.dueAt.toISOString().slice(0, 10)}` : ""} · {task.priority} priority
                    </p>
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}
        </div>
      ) : null}
    </Screen>
  );
}

export default function BriefingPage() {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Preparing the briefing…</p>}>
      <Briefing />
    </Suspense>
  );
}
