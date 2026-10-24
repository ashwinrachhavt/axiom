import Link from "next/link";
import { connection } from "next/server";
import { Empty, Panel, Screen } from "@/components/workspace/ui";
import { getAuthContext } from "@/lib/auth";
import { WORK_OPEN_STATUSES, WORK_PRIORITIES, type WorkRow } from "@/domains/work/queries";
import { listWorkPageForPage, listWorkRowsForPage, getTaskDetailForPage, getActiveFocusSessionForPage, getLastTaskHandoffForPage, listFocusHistoryForPage } from "./data";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { getTaskProvenance } from "@/domains/knowledge/queries";
import { TaskCard } from "./task-controls";
import { FocusTaskButton, ActiveSessionControls } from "./focus-controls";
import { TodaysFlow } from "./todays-flow";
import { TaskEvidence } from "./task-evidence";
import { WorkList } from "./work-list";

/*
 * The Work list on Neon. Server component: reads through the work domain's
 * queries, never the preview store. Today is the owner's explicit commitment
 * (Ready or In progress); Open is everything unfinished; Done is finished work.
 */

const statusLabel: Record<WorkRow["status"], string> = {
  inbox: "Inbox",
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  cancelled: "Cancelled",
};

export type Scope = "today" | "open" | "done";

export function scopeOf(show: string | undefined): Scope {
  return show === "today" || show === "done" ? show : "open";
}

const BASE = "/neuralflow/work";

export async function NeonTasks({
  show,
  selectedTask,
  raw = {},
}: {
  show?: string;
  selectedTask?: string;
  /** The page's search params, so filters and the pager keep each other's state. */
  raw?: RawSearchParams;
}) {
  // Per-user data: render at request time, never prerender.
  await connection();
  const auth = await getAuthContext();
  const scope = scopeOf(show);
  const statusChoices = scope === "today" ? (["ready", "in_progress"] as const) : scope === "open" ? WORK_OPEN_STATUSES : ([] as const);
  const list = parseListParams(raw, { filters: { priority: WORK_PRIORITIES, status: statusChoices } });
  const filtered = Boolean(list.q || list.filters.priority || list.filters.status);
  const found = await listWorkPageForPage(auth, scope, {
    limit: list.pageSize,
    offset: offsetFor(list.page, list.pageSize),
    query: list.q || undefined,
    priority: list.filters.priority as (typeof WORK_PRIORITIES)[number] | undefined,
    status: list.filters.status as (typeof WORK_OPEN_STATUSES)[number] | undefined,
  });
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);
  const rows = found.rows;
  const win = found.window;
  // Reordering is a rank between two neighbours; with rows hidden by a filter
  // the neighbours are not adjacent in the real order, so moves wait for a clear list.
  const canMove = scope !== "done" && !filtered;
  // Detail, its focus history, the live session and the move targets are
  // independent reads. The live session renders wherever on Work the owner
  // is; Work is the focus surface since the rail lost the Focus tab.
  const [detail, openRows, activeSession] = await Promise.all([
    selectedTask && /^[0-9a-f-]{36}$/i.test(selectedTask) ? getTaskDetailForPage(auth, selectedTask) : null,
    selectedTask && /^[0-9a-f-]{36}$/i.test(selectedTask) ? listWorkRowsForPage(auth, "open") : ([] as WorkRow[]),
    getActiveFocusSessionForPage(auth),
  ]);
  // Where the live session's task was last picked up - the start-moment
  // continuity cue; null when no closed session left a next step.
  const lastHandoff = activeSession?.taskId ? await getLastTaskHandoffForPage(auth, activeSession.taskId) : null;
  const focusHistory = detail ? await listFocusHistoryForPage(auth, 10, detail.task.id) : [];
  const provenance = detail ? await getTaskProvenance(auth, detail.task.id) : [];
  const candidates = detail ? openRows.filter((r) => r.id !== detail.task.id).map((r) => ({ id: r.id, title: r.title })) : [];
  const tab = (value: Scope, label: string) => (
    <Link
      key={value}
      className={`rounded px-2 py-1 ${scope === value ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
      href={listHref(BASE, raw, { view: "saved", show: value === "open" ? undefined : value, status: undefined, page: undefined, task: undefined })}
    >
      {label}
    </Link>
  );

  return (
    <Screen
      title="Work"
    >
      {scope === "today" && !selectedTask ? <TodaysFlow auth={auth} raw={raw} /> : null}
      {/* The day's companion tools, reached from the day itself rather than
          the tab row. Projects stay in the More index and command layer. */}
      {scope === "today" && !selectedTask ? (
        <nav aria-label="Related tools" className="-mt-2 mb-4 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
          <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/brain-dump">Brain dump</Link>
          <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/reports">Weekly review</Link>
          <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/rewards">Stone collection</Link>
        </nav>
      ) : null}
      {activeSession ? (
        <Panel
          className="mb-6 border-app-accent/40"
          title={activeSession.subject || "Focus session"}
          description={activeSession.state === "running" ? "A focus session is running." : "A focus session is paused."}
        >
          {lastHandoff ? (
            <p className="mb-3 border-b border-border pb-3 text-[13px] text-muted-foreground">
              Last time: {lastHandoff.nextStep}
            </p>
          ) : null}
          <ActiveSessionControls
            key={`${activeSession.id}:${activeSession.version}`}
            session={{
              id: activeSession.id,
              subject: activeSession.subject,
              state: activeSession.state as "running" | "paused",
              plannedMinutes: activeSession.plannedMinutes,
              elapsedSeconds: activeSession.elapsedSeconds,
              version: activeSession.version,
              hasTask: !!activeSession.taskId,
            }}
          />
        </Panel>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel
          title={scope === "today" ? "Today" : scope === "done" ? "Finished" : "Open tasks"}
          actions={
            <nav aria-label="Saved task filter" className="flex gap-1 text-xs">
              {tab("today", "Today")}
              {tab("open", "Open")}
              {tab("done", "Finished")}
            </nav>
          }
        >
          <div className="mb-4">
            <ListToolbar
              searchPlaceholder="Search tasks"
              filters={[
                ...(statusChoices.length
                  ? [{ key: "status", label: "State", allLabel: "Any state", options: statusChoices.map((v) => ({ value: v, label: statusLabel[v] })) }]
                  : []),
                { key: "priority", label: "Priority", allLabel: "Any priority", options: WORK_PRIORITIES.map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) })) },
              ]}
              total={found.total}
              noun={found.total === 1 ? "task" : "tasks"}
            />
          </div>
          <WorkList
            canMove={canMove}
            showQuickAdd={scope !== "done"}
            emptyState={
              <NoResults
                filtered={filtered}
                clearHref={listHref(BASE, raw, { q: undefined, status: undefined, priority: undefined, page: undefined })}
                emptyTitle={scope === "today" ? "Nothing committed for today" : scope === "done" ? "No finished tasks yet" : "No open tasks"}
              />
            }
            items={rows.map((row, i) => ({
              row: {
                id: row.id,
                title: row.title,
                status: row.status,
                priority: row.priority,
                dueAt: row.dueAt ? row.dueAt.toISOString() : null,
                version: row.version,
                subtaskCount: row.subtaskCount,
                subtasksDone: row.subtasksDone,
                blockedBy: row.blockedBy,
              },
              href: listHref(BASE, raw, { view: "saved", task: row.id }),
              selected: detail?.task.id === row.id,
              up: win[i + found.lead - 1] ? { after: win[i + found.lead - 2]?.id, before: win[i + found.lead - 1]!.id } : null,
              down: win[i + found.lead + 1] ? { after: win[i + found.lead + 1]!.id, before: win[i + found.lead + 2]?.id } : null,
            }))}
          />
          <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} />
        </Panel>

        <Panel title={detail ? "Task" : "Task details"}>
          {detail ? (
            <TaskCard
              data={{
                id: detail.task.id,
                title: detail.task.title,
                description: detail.task.description,
                status: detail.task.status,
                rationale: detail.task.rationale,
                priority: detail.task.priority,
                dueDate: detail.task.dueAt ? detail.task.dueAt.toISOString().slice(0, 10) : null,
                estimateMinutes: detail.task.estimateMinutes,
                version: detail.task.version,
                subtasks: detail.subtasks.map((s) => ({ id: s.id, title: s.title, status: s.status, version: s.version })),
                blockedBy: detail.blockedBy.map((b) => ({ dependencyId: b.dependencyId, title: b.title })),
                blocking: detail.blocking.map((b) => ({ dependencyId: b.dependencyId, title: b.title })),
              }}
              candidates={candidates}
            />
          ) : (
            <Empty title="Select a task" />
          )}
          {detail ? (
            <div className="mt-4 border-t border-border pt-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-[13px] font-medium">Focus history</p>
                {activeSession ? (
                  <span className="text-xs text-muted-foreground">Session live above</span>
                ) : (
                  <FocusTaskButton task={{ id: detail.task.id, title: detail.task.title }} />
                )}
              </div>
              {focusHistory.length ? (
                <div className="divide-y divide-border">
                  {focusHistory.map((session) => (
                    <div key={session.id} className="py-2 first:pt-0">
                      <p className="text-xs text-muted-foreground">
                        {session.state} · {Math.round(session.elapsedSeconds / 60)} min · {session.startedAt.toISOString().slice(0, 10)}
                      </p>
                      {session.whatChanged ? <p className="text-[13px]">Changed: {session.whatChanged}</p> : null}
                      {session.nextStep ? <p className="text-[13px] text-muted-foreground">Next: {session.nextStep}</p> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No focus sessions against this task yet.</p>
              )}
            </div>
          ) : null}
          {detail ? <TaskEvidence items={provenance} /> : null}
        </Panel>
      </div>
    </Screen>
  );
}
