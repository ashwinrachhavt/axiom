import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { outboxEvents } from "@/domains/audit/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { recordDailyQuartz } from "@/domains/gamification/commands";
import { organizations, people } from "@/domains/identity/schema";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { rankBetween } from "./rank";
import { taskDependencies, tasks } from "./schema";

/*
 * Task mutations for the owner (ASH-137 / A03). Every command is one
 * transaction: authenticate (AuthContext) → idempotency receipt → version
 * compare-and-set → change → audit + outbox, committed together or not at all.
 *
 * The caller supplies `idempotencyKey` (a UUID per user intent, reused on
 * retry). Results are plain JSON because a replay returns the stored copy.
 */

export class TaskNotFoundError extends Error {
  readonly code = "task_not_found";
  constructor() {
    super("That task does not exist in this workspace.");
  }
}
export class VersionConflictError extends Error {
  readonly code = "version_conflict";
  constructor() {
    super("This task changed since you loaded it. Reload and try again.");
  }
}
export class DependencyCycleError extends Error {
  readonly code = "dependency_cycle";
  constructor() {
    super("That dependency would make the tasks wait on each other.");
  }
}
export class SubtaskDepthError extends Error {
  readonly code = "subtask_depth";
  constructor() {
    super("A subtask cannot have its own subtasks.");
  }
}
export class RankOrderError extends Error {
  readonly code = "rank_order";
  constructor() {
    super("The neighbouring tasks are no longer in that order. Reload and try again.");
  }
}

type Status = (typeof tasks.$inferSelect)["status"];
type Priority = (typeof tasks.$inferSelect)["priority"];

export type TaskPatch = {
  title?: string;
  description?: string | null;
  status?: Status;
  priority?: Priority;
  rationale?: string | null; // null clears; absent leaves it untouched
  dueAt?: string | null; // ISO; null clears
  estimateMinutes?: number | null;
  tags?: string[];
};

type Keyed = { idempotencyKey?: string };

async function emit(tx: TxDrizzle, auth: AuthContext, topic: string, payload: Record<string, unknown>) {
  await tx.insert(outboxEvents).values({ workspaceId: auth.workspaceId, topic, payload });
}

export type SettledEdge = { id: string; version: number };

/**
 * Mark edges this task was blocking as resolved (or unresolved on reopen).
 * Returns the affected edges with their post-touch version so the caller
 * can record exactly what its transition did: the version is an integer
 * compare-token, bumped on every later touch of the edge, which lets a
 * reopen prove the edge was not resolved by some other path since - and
 * refuse the undo when it cannot prove that.
 */
export async function settleBlockers(
  tx: TxDrizzle,
  auth: AuthContext,
  taskId: string,
  done: boolean,
): Promise<SettledEdge[]> {
  const rows = await tx.execute(sql`
    update task_dependencies
       set resolved_at = ${done ? sql`now()` : sql`null`}, updated_at = now(), updated_by = ${auth.userId},
           version = version + 1
     where workspace_id = ${auth.workspaceId}
       and ((kind = 'blocks' and task_id = ${taskId}) or (kind = 'blocked_by' and depends_on_task_id = ${taskId}))
       and (resolved_at is not null) <> ${done}
       returning id, version`);
  return rows as unknown as SettledEdge[];
}

/** Patch a task if `expectedVersion` still matches; the row's version is the guard. */
export async function updateTask(
  auth: AuthContext,
  input: Keyed & { taskId: string; expectedVersion: number; patch: TaskPatch },
): Promise<{ id: string; version: number }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "updateTask", ...input }, async () => {
      const p = input.patch;
      // Finishing a task from the board or detail view must earn the same
      // daily Quartz as the list's Done button, so note the prior status.
      let finishing = false;
      // A terminal transition only truly happens from a non-terminal state:
      // re-saving an already-done task with status "done" (the detail form
      // always sends its status) must not overwrite the attribution the real
      // transition recorded.
      let terminalizing = false;
      if (p.status === "done" || p.status === "cancelled") {
        const [before] = await tx
          .select({ status: tasks.status })
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, auth.workspaceId)))
          .limit(1);
        finishing = p.status === "done" && !!before && before.status !== "done";
        terminalizing = !!before && before.status !== "done" && before.status !== "cancelled";
      }
      const set: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: auth.userId,
        version: sql`${tasks.version} + 1`,
      };
      if (p.title !== undefined) set.title = p.title;
      if (p.rationale !== undefined) set.rationale = p.rationale;
      if (p.description !== undefined) set.description = p.description;
      if (p.priority !== undefined) set.priority = p.priority;
      if (p.dueAt !== undefined) set.dueAt = p.dueAt === null ? null : new Date(p.dueAt);
      if (p.estimateMinutes !== undefined) set.estimateMinutes = p.estimateMinutes;
      if (p.tags !== undefined) set.tags = p.tags;
      if (p.status !== undefined) {
        set.status = p.status;
        set.completedAt = p.status === "done" ? new Date() : null;
        set.cancelledAt = p.status === "cancelled" ? new Date() : null;
      }

      const [row] = await tx
        .update(tasks)
        .set(set)
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.workspaceId, auth.workspaceId),
            eq(tasks.version, input.expectedVersion),
            isNull(tasks.archivedAt),
          ),
        )
        .returning({ id: tasks.id, version: tasks.version, title: tasks.title });
      if (!row) {
        const [exists] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.archivedAt)))
          .limit(1);
        throw exists ? new VersionConflictError() : new TaskNotFoundError();
      }

      if (finishing) await recordDailyQuartz(tx, auth, row.id);
      // A real terminal transition records exactly which edges it settled,
      // so a later reopen undoes by identity rather than by guesswork. The
      // settle call itself still runs for any done/cancelled patch (its
      // resolved_at guard makes a re-save a no-op), but only the transition
      // from a non-terminal state may claim attribution.
      const settledEdgeIds =
        p.status === "done" || p.status === "cancelled" ? await settleBlockers(tx, auth, row.id, true) : undefined;
      if (p.status !== undefined && p.status !== "done" && p.status !== "cancelled") {
        await settleBlockers(tx, auth, row.id, false);
      }

      const changed = Object.keys(p).filter((k) => (p as Record<string, unknown>)[k] !== undefined);
      await recordAudit(
        auth,
        {
          action: "task.updated",
          subjectType: "task",
          subjectId: row.id,
          summary: `Updated task "${row.title}" (${changed.join(", ")})`,
          metadata: { fields: changed, version: row.version, ...(terminalizing ? { settledEdges: settledEdgeIds } : {}) },
        },
        tx,
      );
      await emit(tx, auth, "task.updated", { taskId: row.id, fields: changed, version: row.version });
      return { id: row.id, version: row.version };
    });
    return value;
  });
}

/** One level of subtasks, ranked after the last sibling, inheriting project and space. */
export async function createSubtask(
  auth: AuthContext,
  input: Keyed & { parentTaskId: string; title: string },
): Promise<{ id: string; version: number }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "createSubtask", ...input }, async () => {
      const [parent] = await tx
        .select({ id: tasks.id, parentTaskId: tasks.parentTaskId, projectId: tasks.projectId, spaceId: tasks.spaceId })
        .from(tasks)
        .where(and(eq(tasks.id, input.parentTaskId), eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.archivedAt)))
        .for("update")
        .limit(1);
      if (!parent) throw new TaskNotFoundError();
      if (parent.parentTaskId) throw new SubtaskDepthError();

      // The parent row lock above serializes sibling inserts, so "last rank + 1"
      // cannot hand two children the same rank.
      const [last] = await tx
        .select({ rank: tasks.rank })
        .from(tasks)
        .where(and(eq(tasks.parentTaskId, parent.id), eq(tasks.workspaceId, auth.workspaceId)))
        .orderBy(sql`${tasks.rank} collate "C" desc`)
        .limit(1);

      const [row] = await tx
        .insert(tasks)
        .values({
          workspaceId: auth.workspaceId,
          parentTaskId: parent.id,
          projectId: parent.projectId,
          spaceId: parent.spaceId,
          title: input.title,
          rank: rankBetween(last?.rank ?? null, null),
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: tasks.id, version: tasks.version });

      await recordAudit(
        auth,
        {
          action: "task.subtask_created",
          subjectType: "task",
          subjectId: row.id,
          summary: `Added subtask "${input.title}"`,
          metadata: { parentTaskId: parent.id },
        },
        tx,
      );
      await emit(tx, auth, "task.created", { taskId: row.id, parentTaskId: parent.id });
      return row;
    });
    return value;
  });
}

/**
 * Place a task between two neighbours. A drag writes this one row. Either
 * neighbour may be omitted for "first" / "last"; if both are given they must
 * still be in that order, otherwise the caller's view is stale.
 */
export async function moveTask(
  auth: AuthContext,
  input: Keyed & { taskId: string; expectedVersion: number; afterTaskId?: string; beforeTaskId?: string },
): Promise<{ id: string; rank: string; version: number }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "moveTask", ...input }, async () => {
      const rankOf = async (id: string | undefined) => {
        if (!id) return null;
        const [r] = await tx
          .select({ rank: tasks.rank })
          .from(tasks)
          .where(and(eq(tasks.id, id), eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.archivedAt)))
          .limit(1);
        if (!r) throw new TaskNotFoundError();
        return r.rank;
      };
      let lo = await rankOf(input.afterTaskId);
      let hi = await rankOf(input.beforeTaskId);
      if (lo !== null && lo === hi) {
        // Tasks created before ranks were assigned all share "m". A tie has no
        // gap to move into, so spread the open top-level tasks once (stable by
        // rank then id) and read the neighbours again.
        await spreadRanks(tx, auth);
        lo = await rankOf(input.afterTaskId);
        hi = await rankOf(input.beforeTaskId);
      }
      if (lo !== null && hi !== null && lo >= hi) throw new RankOrderError();

      const rank = rankBetween(lo, hi);
      const [row] = await tx
        .update(tasks)
        .set({ rank, updatedAt: new Date(), updatedBy: auth.userId, version: sql`${tasks.version} + 1` })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.workspaceId, auth.workspaceId),
            eq(tasks.version, input.expectedVersion),
            isNull(tasks.archivedAt),
          ),
        )
        .returning({ id: tasks.id, rank: tasks.rank, version: tasks.version, title: tasks.title });
      if (!row) {
        const [exists] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.archivedAt)))
          .limit(1);
        throw exists ? new VersionConflictError() : new TaskNotFoundError();
      }
      await recordAudit(
        auth,
        {
          action: "task.moved",
          subjectType: "task",
          subjectId: row.id,
          summary: `Reordered task "${row.title}"`,
          metadata: { rank },
        },
        tx,
      );
      await emit(tx, auth, "task.updated", { taskId: row.id, fields: ["rank"], version: row.version });
      return { id: row.id, rank: row.rank, version: row.version };
    });
    return value;
  });
}

/** Renumber a workspace's top-level tasks in their current order. No version bump: order is unchanged. */
async function spreadRanks(tx: TxDrizzle, auth: AuthContext) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`rank:${auth.workspaceId}`}, 0))`);
  const rows = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.parentTaskId)))
    .orderBy(sql`${tasks.rank} collate "C"`, tasks.id);
  let prev: string | null = null;
  for (const row of rows) {
    const next = rankBetween(prev, null);
    await tx.update(tasks).set({ rank: next }).where(eq(tasks.id, row.id));
    prev = next;
  }
}

async function ownedTask(tx: TxDrizzle, auth: AuthContext, id: string) {
  const [t] = await tx
    .select({ id: tasks.id, title: tasks.title, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.archivedAt)))
    .limit(1);
  if (!t) throw new TaskNotFoundError();
  return t;
}

/**
 * Record that one task blocks another. `blocks`: `taskId` blocks
 * `otherTaskId`. `blocked_by`: `taskId` waits on `otherTaskId`. The two read
 * the same edge from either end, so an existing edge in either orientation is
 * returned rather than duplicated, and a cycle is refused before insert.
 * An already-finished blocker is recorded as resolved.
 */
export async function addDependency(
  auth: AuthContext,
  input: Keyed & { taskId: string; otherTaskId: string; kind: "blocks" | "blocked_by"; note?: string },
): Promise<{ id: string; created: boolean }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "addDependency", ...input }, async () => {
      if (input.taskId === input.otherTaskId) throw new DependencyCycleError();
      const a = await ownedTask(tx, auth, input.taskId);
      const b = await ownedTask(tx, auth, input.otherTaskId);
      const blocker = input.kind === "blocks" ? a : b;
      const blocked = input.kind === "blocks" ? b : a;

      // Serialize dependency writes per workspace: two concurrent inserts could
      // each pass the cycle check and together close a loop.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deps:${auth.workspaceId}`}, 0))`);

      const existing = await tx.execute(sql`
        select id from task_dependencies
         where workspace_id = ${auth.workspaceId}
           and ((kind = 'blocks' and task_id = ${blocker.id} and depends_on_task_id = ${blocked.id})
             or (kind = 'blocked_by' and task_id = ${blocked.id} and depends_on_task_id = ${blocker.id}))
         limit 1`);
      if (existing.length > 0) return { id: (existing[0] as { id: string }).id, created: false };

      // Cycle: the new blocked task already (transitively) blocks the new blocker.
      const cycle = await tx.execute(sql`
        with recursive edges as (
          select task_id as blocker, depends_on_task_id as blocked from task_dependencies
            where kind = 'blocks' and workspace_id = ${auth.workspaceId}
          union all
          select depends_on_task_id, task_id from task_dependencies
            where kind = 'blocked_by' and workspace_id = ${auth.workspaceId}
        ), reach(id) as (
          select ${blocked.id}::uuid
          union
          select e.blocked from edges e join reach r on e.blocker = r.id
        )
        select 1 from reach where id = ${blocker.id}::uuid limit 1`);
      if (cycle.length > 0) throw new DependencyCycleError();

      const done = blocker.status === "done" || blocker.status === "cancelled";
      const [row] = await tx
        .insert(taskDependencies)
        .values({
          workspaceId: auth.workspaceId,
          taskId: a.id,
          kind: input.kind,
          dependsOnTaskId: b.id,
          note: input.note ?? null,
          resolvedAt: done ? new Date() : null,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: taskDependencies.id });

      await recordAudit(
        auth,
        {
          action: "task.dependency_added",
          subjectType: "task",
          subjectId: blocked.id,
          summary: `"${blocker.title}" now blocks "${blocked.title}"`,
          metadata: { blockerId: blocker.id, blockedId: blocked.id },
        },
        tx,
      );
      await emit(tx, auth, "task.updated", { taskId: blocked.id, fields: ["dependencies"] });
      return { id: row.id, created: true };
    });
    return value;
  });
}

/** Record that a task is waiting on a person or organization. */
export async function addWaitingOn(
  auth: AuthContext,
  input: Keyed & { taskId: string; targetType: "person" | "organization"; targetId: string; note?: string },
): Promise<{ id: string; created: boolean }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "addWaitingOn", ...input }, async () => {
      const task = await ownedTask(tx, auth, input.taskId);
      // waiting_on_id carries no FK (polymorphic), so tenancy is checked here.
      const table = input.targetType === "person" ? people : organizations;
      const [target] = await tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.id, input.targetId), eq(table.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!target) throw new Error(`${input.targetType} not found in workspace`);

      const [row] = await tx
        .insert(taskDependencies)
        .values({
          workspaceId: auth.workspaceId,
          taskId: task.id,
          kind: "waiting_on",
          waitingOnType: input.targetType,
          waitingOnId: target.id,
          note: input.note ?? null,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .onConflictDoNothing()
        .returning({ id: taskDependencies.id });
      if (!row) {
        const [dup] = await tx
          .select({ id: taskDependencies.id })
          .from(taskDependencies)
          .where(
            and(
              eq(taskDependencies.taskId, task.id),
              eq(taskDependencies.waitingOnType, input.targetType),
              eq(taskDependencies.waitingOnId, target.id),
            ),
          )
          .limit(1);
        return { id: dup.id, created: false };
      }
      await recordAudit(
        auth,
        {
          action: "task.waiting_on_added",
          subjectType: "task",
          subjectId: task.id,
          summary: `"${task.title}" is waiting on a ${input.targetType}`,
          metadata: { targetType: input.targetType, targetId: target.id },
        },
        tx,
      );
      return { id: row.id, created: true };
    });
    return value;
  });
}

export async function removeDependency(
  auth: AuthContext,
  input: Keyed & { dependencyId: string },
): Promise<{ removed: boolean }> {
  return withTransaction(async (tx) => {
    const { value } = await withReceipt(tx, auth, input.idempotencyKey, { op: "removeDependency", ...input }, async () => {
      const [row] = await tx
        .delete(taskDependencies)
        .where(and(eq(taskDependencies.id, input.dependencyId), eq(taskDependencies.workspaceId, auth.workspaceId)))
        .returning({ id: taskDependencies.id, taskId: taskDependencies.taskId });
      if (!row) return { removed: false };
      await recordAudit(
        auth,
        {
          action: "task.dependency_removed",
          subjectType: "task",
          subjectId: row.taskId,
          summary: "Removed a task dependency",
          metadata: { dependencyId: row.id },
        },
        tx,
      );
      await emit(tx, auth, "task.updated", { taskId: row.taskId, fields: ["dependencies"] });
      return { removed: true };
    });
    return value;
  });
}
