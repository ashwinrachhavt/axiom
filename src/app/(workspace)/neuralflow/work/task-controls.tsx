"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/workspace/ui";
import { Select } from "@/components/ui/select";
import {
  addDependencyAction,
  createSubtaskAction,
  moveTaskAction,
  removeDependencyAction,
  reopenTaskAction,
  updateTaskAction,
} from "./actions";

/*
 * Client islands for the Neon-backed Work list. Each user intent mints one
 * idempotency key and keeps it until the action succeeds, so a retry after a
 * dropped response replays instead of repeating.
 */

function useIntent() {
  const ref = useRef<string | null>(null);
  return {
    key: () => (ref.current ??= crypto.randomUUID()),
    reset: () => {
      ref.current = null;
    },
  };
}

type Outcome = { ok: true } | { ok: false; error: string };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(intent: ReturnType<typeof useIntent>, fn: () => Promise<Outcome>, onOk?: () => void) {
    setError(null);
    start(async () => {
      try {
        const res = await fn();
        if (res.ok) {
          intent.reset();
          onOk?.();
          // These islands sit on server-rendered views: refresh so a saved
          // change shows where it landed without a manual reload.
          router.refresh();
        } else {
          intent.reset();
          setError(res.error);
        }
      } catch {
        // Network or server failure: keep the key so a retry is idempotent.
        setError("Could not reach the server. Try again.");
      }
    });
  }
  return { pending, error, run };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-xs text-destructive">
      {error}
    </p>
  ) : null;
}

const statuses = [
  ["inbox", "Inbox"],
  ["backlog", "Backlog"],
  ["ready", "Ready"],
  ["in_progress", "In progress"],
  ["waiting", "Waiting"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
] as const;
const priorities = ["none", "low", "medium", "high", "urgent"] as const;

type Status = (typeof statuses)[number][0];
type Priority = (typeof priorities)[number];

export type CardData = {
  id: string;
  title: string;
  description: string | null;
  rationale: string | null;
  status: Status;
  priority: Priority;
  dueDate: string | null; // yyyy-mm-dd
  estimateMinutes: number | null;
  version: number;
  subtasks: { id: string; title: string; status: Status; version: number }[];
  blockedBy: { dependencyId: string; title: string }[];
  blocking: { dependencyId: string; title: string }[];
};

export function TaskCard({ data, candidates }: { data: CardData; candidates: { id: string; title: string }[] }) {
  const save = useIntent();
  const sub = useIntent();
  const dep = useIntent();
  const rm = useIntent();
  const toggle = useIntent();
  const saver = useRun();
  const subRun = useRun();
  const depRun = useRun();
  const rmRun = useRun();
  const toggleRun = useRun();
  const reopenRun = useRun();
  const [reopenNote, setReopenNote] = useState<string | null>(null);
  const [subTitle, setSubTitle] = useState("");
  const [otherId, setOtherId] = useState("");
  const [kind, setKind] = useState<"blocked_by" | "blocks">("blocked_by");

  function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const due = String(f.get("due") || "");
    const estimate = String(f.get("estimate") || "");
    saver.run(save, () =>
      updateTaskAction({
        taskId: data.id,
        expectedVersion: data.version,
        idempotencyKey: save.key(),
        patch: {
          title: String(f.get("title") || "").trim(),
          description: String(f.get("description") || "").trim() || null,
          rationale: String(f.get("rationale") || "").trim() || null,
          status: f.get("status") as Status,
          priority: f.get("priority") as Priority,
          dueAt: due ? new Date(`${due}T12:00:00Z`).toISOString() : null,
          estimateMinutes: estimate ? Number(estimate) : null,
        },
      }),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* key: a new version remounts the form so defaults reflect the saved row */}
      <form key={data.version} onSubmit={onSave} className="grid gap-3">
        <Field label="Title">
          <Input name="title" defaultValue={data.title} required maxLength={300} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <Select name="status" defaultValue={data.status}>
              {statuses.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select name="priority" defaultValue={data.priority}>
              {priorities.map((p) => (
                <option key={p} value={p}>
                  {p[0].toUpperCase() + p.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due">
            <Input name="due" type="date" defaultValue={data.dueDate ?? ""} />
          </Field>
          <Field label="Estimate (minutes)">
            <Input name="estimate" type="number" min={0} defaultValue={data.estimateMinutes ?? ""} />
          </Field>
        </div>
        <Field label="Why it's on the list">
          {/* A reason runs to a sentence or two: multiline like Notes, not a
              single-line input that hides most of a 500-char value. */}
          <textarea name="rationale" defaultValue={data.rationale ?? ""} maxLength={500} rows={2} placeholder="Why this matters" className="w-full rounded-md border border-input bg-background p-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </Field>
        <Field label="Notes">
          <textarea name="description" defaultValue={data.description ?? ""} rows={3} className="w-full rounded-md border border-input bg-background p-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saver.pending}>
            Save task
          </Button>
          <ErrorLine error={saver.error} />
        </div>
      </form>

      {data.status === "done" || data.status === "cancelled" ? (
        <section aria-label="Reopen" className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={reopenRun.pending}
            onClick={() =>
              reopenRun.run(save, async () => {
                const r = await reopenTaskAction(data.id, data.version);
                if (r.ok) setReopenNote(r.note);
                return r;
              })
            }
          >
            Reopen task
          </Button>
          {/* Undo the terminal transition, not history: the stone and the
              audit trail stay on record, external effects cannot be undone,
              and a blocker link that changed since stays exactly as it is. */}
          <p className="text-xs text-muted-foreground">
            Back to Ready. Any stone earned and the history stay on record. Blockers its completion released wait on
            it again; a link that changed since stays as it is.
          </p>
          {reopenNote ? <p className="text-xs text-muted-foreground">{reopenNote}</p> : null}
          <ErrorLine error={reopenRun.error} />
        </section>
      ) : null}

      <section aria-label="Subtasks" className="grid gap-2">
        <h3 className="text-[13px] font-medium">Subtasks</h3>
        {data.subtasks.length === 0 && <p className="text-xs text-muted-foreground">No subtasks yet.</p>}
        <ul className="divide-y divide-border">
          {data.subtasks.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-[13px]">
              <span className={s.status === "done" ? "text-muted-foreground line-through" : ""}>{s.title}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={toggleRun.pending}
                aria-label={`${s.status === "done" ? "Reopen" : "Complete"} subtask ${s.title}`}
                onClick={() =>
                  toggleRun.run(toggle, () =>
                    updateTaskAction({
                      taskId: s.id,
                      expectedVersion: s.version,
                      idempotencyKey: toggle.key(),
                      patch: { status: s.status === "done" ? "ready" : "done" },
                    }),
                  )
                }
              >
                {s.status === "done" ? "Reopen" : "Done"}
              </Button>
            </li>
          ))}
        </ul>
        <ErrorLine error={toggleRun.error} />
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const value = subTitle.trim();
            if (!value) return;
            subRun.run(sub, () => createSubtaskAction({ parentTaskId: data.id, title: value, idempotencyKey: sub.key() }), () => setSubTitle(""));
          }}
        >
          <Input aria-label="New subtask title" placeholder="Add a subtask" value={subTitle} maxLength={300} onChange={(e) => setSubTitle(e.target.value)} />
          <Button type="submit" variant="outline" disabled={subRun.pending || !subTitle.trim()}>
            Add subtask
          </Button>
        </form>
        <ErrorLine error={subRun.error} />
      </section>

      <section aria-label="Dependencies" className="grid gap-2">
        <h3 className="text-[13px] font-medium">Dependencies</h3>
        {data.blockedBy.length === 0 && data.blocking.length === 0 && <p className="text-xs text-muted-foreground">Nothing blocks this task and it blocks nothing.</p>}
        <ul className="divide-y divide-border">
          {data.blockedBy.map((d) => (
            <li key={d.dependencyId} className="flex items-center justify-between gap-3 py-2 text-[13px]">
              <span>Blocked by {d.title}</span>
              <Button size="sm" variant="ghost" disabled={rmRun.pending} aria-label={`Remove dependency on ${d.title}`} onClick={() => rmRun.run(rm, () => removeDependencyAction({ dependencyId: d.dependencyId, idempotencyKey: rm.key() }))}>
                Remove
              </Button>
            </li>
          ))}
          {data.blocking.map((d) => (
            <li key={d.dependencyId} className="flex items-center justify-between gap-3 py-2 text-[13px]">
              <span>Blocks {d.title}</span>
              <Button size="sm" variant="ghost" disabled={rmRun.pending} aria-label={`Remove dependency from ${d.title}`} onClick={() => rmRun.run(rm, () => removeDependencyAction({ dependencyId: d.dependencyId, idempotencyKey: rm.key() }))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <ErrorLine error={rmRun.error} />
        {candidates.length > 0 && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!otherId) return;
              depRun.run(dep, () => addDependencyAction({ taskId: data.id, otherTaskId: otherId, kind, idempotencyKey: dep.key() }), () => setOtherId(""));
            }}
          >
            <Select aria-label="Dependency kind" className="w-auto" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="blocked_by">Is blocked by</option>
              <option value="blocks">Blocks</option>
            </Select>
            <Select aria-label="Other task" className="w-auto min-w-40 flex-1" value={otherId} onChange={(e) => setOtherId(e.target.value)}>
              <option value="">Choose a task</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="outline" disabled={depRun.pending || !otherId}>
              Add dependency
            </Button>
          </form>
        )}
        <ErrorLine error={depRun.error} />
      </section>
    </div>
  );
}

export function BoardCard({
  taskId,
  title,
  status,
  priority,
  version,
  detailHref,
  blockedBy,
  up,
  down,
}: {
  taskId: string;
  title: string;
  status: Status;
  priority: Priority;
  version: number;
  detailHref: string;
  blockedBy: number;
  up: { after?: string; before?: string } | null;
  down: { after?: string; before?: string } | null;
}) {
  const intent = useIntent();
  const { pending, error, run } = useRun();
  return (
    <div className="panel rounded-lg p-3">
      <div className="flex items-start justify-between gap-2">
        <a href={detailHref} className="min-w-0 text-[13px] font-medium hover:underline">
          {title}
        </a>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || !up}
            aria-label={`Move ${title} up`}
            onClick={() =>
              up && run(intent, () => moveTaskAction({ taskId, expectedVersion: version, afterTaskId: up.after, beforeTaskId: up.before, idempotencyKey: intent.key() }))
            }
          >
            Up
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || !down}
            aria-label={`Move ${title} down`}
            onClick={() =>
              down && run(intent, () => moveTaskAction({ taskId, expectedVersion: version, afterTaskId: down.after, beforeTaskId: down.before, idempotencyKey: intent.key() }))
            }
          >
            Down
          </Button>
        </div>
      </div>
      <div className="my-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
        {priority !== "none" && <span>{priority}</span>}
        {blockedBy > 0 && <span>Blocked by {blockedBy}</span>}
      </div>
      <Select
        aria-label={`Move ${title} to status`}
        value={status}
        disabled={pending}
        onChange={(event) =>
          run(intent, () => updateTaskAction({ taskId, expectedVersion: version, idempotencyKey: intent.key(), patch: { status: event.target.value as Status } }))
        }
      >
        {statuses.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      <ErrorLine error={error} />
    </div>
  );
}
