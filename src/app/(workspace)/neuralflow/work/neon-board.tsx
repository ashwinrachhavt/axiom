import Link from "next/link";
import { io } from "next/cache";
import { Empty, Panel, Screen } from "@/components/workspace/ui";
import { getAuthContext } from "@/lib/auth";
import { WORK_PRIORITIES, type WorkRow } from "@/domains/work/queries";
import { listWorkRowsForPage } from "./data";
import { ListToolbar } from "@/components/list/list-toolbar";
import { matchesQuery, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { BoardCard } from "./task-controls";

/*
 * The Work board on Neon: the same canonical rows as the saved list, grouped
 * into status lanes. A lane move is a status patch; a lane reorder is the one
 * global rank, so the list and the board never disagree about order.
 */

const lanes: { id: WorkRow["status"]; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In progress" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
];

export async function NeonBoard({ raw = {} }: { raw?: RawSearchParams }) {
  await io();
  const auth = await getAuthContext();
  const list = parseListParams(raw, { filters: { priority: WORK_PRIORITIES } });
  const filtered = Boolean(list.q || list.filters.priority);
  const keep = (row: WorkRow) =>
    (!list.filters.priority || row.priority === list.filters.priority) && matchesQuery(list.q, row.title);
  const [openRows, doneRows] = await Promise.all([listWorkRowsForPage(auth, "open"), listWorkRowsForPage(auth, "done", 20)]);
  const open = openRows.filter(keep);
  const done = doneRows.filter(keep);
  const rowsByStatus = new Map<WorkRow["status"], WorkRow[]>();
  for (const lane of lanes) rowsByStatus.set(lane.id, []);
  for (const row of open) rowsByStatus.get(row.status)?.push(row);
  for (const row of done) rowsByStatus.get(row.status)?.push(row);

  return (
    <Screen
      title="Work board"
      description="Moving a card changes its saved status; reordering a lane writes the same rank the list sorts by."
    >
      <ListToolbar
        searchPlaceholder="Search tasks"
        filters={[
          { key: "priority", label: "Priority", allLabel: "Any priority", options: WORK_PRIORITIES.map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) })) },
        ]}
      />
      <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {lanes.map((lane) => {
          const rows = rowsByStatus.get(lane.id) ?? [];
          return (
            <Panel
              key={lane.id}
              title={lane.label}
              description={`${rows.length} ${rows.length === 1 ? "task" : "tasks"}${lane.id === "in_progress" && rows.length > 3 ? "; above the suggested WIP limit of 3" : ""}`}
            >
              {rows.length === 0 ? (
                <Empty title="No tasks in this lane" />
              ) : (
                <ul className="flex flex-col gap-2">
                  {rows.map((row, i) => (
                    <li key={row.id}>
                      <BoardCard
                        taskId={row.id}
                        title={row.title}
                        status={row.status}
                        priority={row.priority}
                        version={row.version}
                        detailHref={`/neuralflow/work?view=saved&task=${row.id}`}
                        blockedBy={row.blockedBy}
                        up={!filtered && i > 0 ? { after: rows[i - 2]?.id, before: rows[i - 1].id } : null}
                        down={!filtered && i < rows.length - 1 ? { after: rows[i + 1].id, before: rows[i + 2]?.id } : null}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Finished work shows the 20 most recent. Cancelled tasks are on the <Link href="/neuralflow/work?view=saved&show=done" className="underline underline-offset-4">Finished</Link> list.
      </p>
    </Screen>
  );
}
