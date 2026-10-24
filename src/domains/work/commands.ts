import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { auditEvents } from "@/domains/audit/schema";
import { recordDailyQuartz } from "@/domains/gamification/commands";
import { withReceipt } from "@/domains/audit/receipt";
import { linkTargetKinds } from "@/db/columns";
import { organizations, people } from "@/domains/identity/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { taskLinks, tasks } from "./schema";
import { rankBetween } from "./rank";
import { settleBlockers } from "./task-commands";

/*
 * The work domain's mutation surface. Minimal by design: callers outside the
 * domain (e.g. knowledge accepting an obligation) go through here so task
 * invariants live in one place.
 */

type Db = typeof db | TxDrizzle;

/* One page per render; Today paginates past this when the list outgrows a screen. */
const OPEN_TASK_PAGE = 100;

export type TaskLinkInput = {
  targetType: (typeof linkTargetKinds)[number];
  targetId: string;
  label?: string;
};

/**
 * The only task insert. Defaults are status "inbox", priority "none", rank "m".
 *
 * `links` lives here rather than at each caller because "a task about a
 * document / a person / an organization" is the same edge every caller wants
 * to write, and writing it twice is how the two edges drift. The caller owns
 * the audit row, because only it knows the action name that describes the
 * change (an obligation acceptance is not a bare task creation).
 */
export async function createTask(
  auth: AuthContext,
  input: {
    title: string;
    description?: string;
    rationale?: string;
    dueAt?: Date;
    priority?: (typeof tasks.$inferSelect)["priority"];
    estimateMinutes?: number;
    tags?: string[];
    rank?: string;
    links?: TaskLinkInput[];
  },
  tx: Db = db,
) {
  let rank = input.rank;
  if (!rank) {
    // New work goes to the end of the list. The lock makes "last rank" safe:
    // two concurrent creates would otherwise read the same last rank and tie,
    // and a tie cannot be ordered by a later move.
    if (tx === db) throw new Error("createTask needs a transaction to assign a rank");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`rank:${auth.workspaceId}`}, 0))`);
    const [last] = await tx
      .select({ rank: tasks.rank })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.parentTaskId)))
      .orderBy(sql`${tasks.rank} collate "C" desc`)
      .limit(1);
    rank = rankBetween(last?.rank ?? null, null);
  }
  const [task] = await tx
    .insert(tasks)
    .values({
      workspaceId: auth.workspaceId,
      title: input.title,
      description: input.description ?? null,
      rationale: input.rationale ?? null,
      dueAt: input.dueAt ?? null,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.estimateMinutes ? { estimateMinutes: input.estimateMinutes } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      rank,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();

  if (input.links?.length) {
    // task_links_edge_key is unique on (task, type, target): a repeated entry
    // would abort the whole transaction with a constraint error, so collapse
    // duplicates here where the caller's intent is unambiguous.
    const unique = new Map(
      input.links.map((link) => [`${link.targetType}:${link.targetId}`, link]),
    );
    await tx.insert(taskLinks).values(
      [...unique.values()].map((link) => ({
        workspaceId: auth.workspaceId,
        taskId: task.id,
        targetType: link.targetType,
        targetId: link.targetId,
        label: link.label ?? null,
      })),
    );
  }
  return task;
}

/** Owner-created task: createTask in its own transaction plus the task.created audit row. */
export async function createOwnerTask(
  auth: AuthContext,
  input: {
    title: string;
    rationale?: string;
    dueAt?: Date;
    priority?: (typeof tasks.$inferSelect)["priority"];
    estimateMinutes?: number;
    tags?: string[];
    personId?: string; organizationId?: string;
    idempotencyKey?: string;
  },
): Promise<{ id: string }> {
  return withTransaction(async (tx) => {
    const { idempotencyKey, ...request } = input;
    const { value } = await withReceipt(tx, auth, idempotencyKey, { op: "createOwnerTask", ...request }, async () => {
    // task_links.target_id carries no FK (it is polymorphic), so the link's
    // tenancy is this check's job. Without it a caller could point a task at
    // another workspace's person: no row leaks, but the edge would be a lie.
    const links: TaskLinkInput[] = [];
    if (input.personId) {
      const [person] = await tx
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.id, input.personId), eq(people.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!person) throw new Error("person not found in workspace");
      links.push({ targetType: "person", targetId: person.id, label: "Person" });
    }
    if (input.organizationId) {
      const [org] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.id, input.organizationId),
            eq(organizations.workspaceId, auth.workspaceId),
          ),
        )
        .limit(1);
      if (!org) throw new Error("organization not found in workspace");
      links.push({ targetType: "organization", targetId: org.id, label: "Organization" });
    }

    const task = await createTask(
      auth,
      {
        title: input.title,
        rationale: input.rationale,
        dueAt: input.dueAt,
        priority: input.priority,
        estimateMinutes: input.estimateMinutes,
        tags: input.tags,
        links,
      },
      tx,
    );

    await recordAudit(
      auth,
      {
        action: "task.created",
        subjectType: "task",
        subjectId: task.id,
        summary: `Created task "${task.title}"`,
        metadata: {
          personId: input.personId ?? null,
          organizationId: input.organizationId ?? null,
        },
      },
      tx,
    );
    return { id: task.id };
    });
    return value;
  });
}

/** Open tasks, soonest due first, nulls last. One page; paginate when the list outgrows a screen. */
export async function listOpenTasks(auth: AuthContext) {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      dueAt: tasks.dueAt,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, auth.workspaceId),
        isNull(tasks.archivedAt),
        sql`${tasks.status} not in ('done', 'cancelled')`,
      ),
    )
    .orderBy(sql`${tasks.dueAt} asc nulls last`, tasks.createdAt)
    .limit(OPEN_TASK_PAGE);
}

/**
 * Complete a task through the row's own guard. The WHERE clause carries the
 * current status, so a double-click is a no-op and a task completed in another
 * tab is not silently re-completed; the caller gets `null` and says so.
 */
export async function completeTask(
  auth: AuthContext,
  input: { taskId: string; sentence?: string },
): Promise<{ id: string; quartzEarned: boolean } | null> {
  // The completion question ("what did you actually do?") is optional to
  // answer; a blank or whitespace-only answer records no sentence. The action
  // caps the length; the domain trims defensively.
  const note = input.sentence?.trim().slice(0, 1000) || undefined;
  return withTransaction(async (tx) => {
    const [task] = await tx
      .update(tasks)
      .set({
        status: "done",
        completedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: auth.userId,
        version: sql`${tasks.version} + 1`,
      })
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.workspaceId, auth.workspaceId),
          sql`${tasks.status} not in ('done', 'cancelled')`,
        ),
      )
      .returning({ id: tasks.id, title: tasks.title });
    // A no-op click writes nothing, including no audit row: the guard decided
    // there was no change to record.
    if (!task) return null;

    // Whatever this task was blocking is no longer waiting on it. The audit
    // row records exactly which edges this completion settled, so a later
    // reopen undoes by identity, not by timestamp guesswork.
    const settledEdges = await settleBlockers(tx, auth, task.id, true);

    await recordAudit(
      auth,
      {
        action: "task.completed",
        subjectType: "task",
        subjectId: task.id,
        summary: `Completed task "${task.title}"`,
        // The sentence is durable even when no stone is earned today: it
        // rides on the stone when one is awarded, and stays on the
        // completion's audit row either way. The settled blocker edges ride
        // alongside so a later reopen undoes by identity.
        metadata: note ? { settledEdges, completionNote: note } : { settledEdges },
      },
      tx,
    );
    // A10 Quartz rule: first completed task of the day earns the daily
    // Quartz. Same transaction, skip-silent when the day already has one.
    const quartzEarned = await recordDailyQuartz(tx, auth, task.id, note);
    return { id: task.id, quartzEarned };
  });
}

/**
 * Undo a terminal transition (Product Spec: "Undo for every terminal
 * transition"). Two guards, both on the row itself: the task must be done or
 * cancelled, and its version must still be the one the caller saw. The
 * version guard is the ABA defense - a stale "done" view cannot undo a
 * newer reopen-and-recomplete cycle it never saw. Reopening lands the task
 * in `ready` - the prior open state is not recorded anywhere, and inventing
 * one would be a lie.
 *
 * Which blocker edges a reopen un-settles is decided by identity, not by
 * timestamp: every terminalization records the exact edge ids it settled in
 * its audit row, and the reopen undoes the edges the LATEST terminal audit
 * event named. An edge resolved any other way - linked against the task
 * while it was already terminal, for example - was never named and is never
 * touched. A task terminalized before this attribution existed has no named
 * edges; its reopen leaves every edge alone rather than guess.
 *
 * Scope of the undo, honestly: the task row, its completedAt, and the
 * blocker edges its own terminalization settled. It does NOT reclaim an
 * earned stone (the ledger is append-only - the daily-stone idempotency key
 * refuses a second award the same day; a re-completion on a later day earns
 * that day's first-completion stone, exactly as completing any other task
 * that day would), does NOT rewrite the audit history (the terminal row
 * stands; the reopen adds its own), and cannot undo an external effect
 * another system already felt.
 */

export type BulkCompleteOutcome = {
  completed: string[];
  skipped: string[];
  /**
   * Threw mid-write: that row's real state is unknown - it may have
   * completed before the error. Named so the caller can say "check it" -
   * never silently counted either way and never retried automatically. The
   * batch stops at the first unknown: every id after it is unattempted,
   * which the caller can compute from the three lists and the request.
   */
  unknown: string[];
  /**
   * Ids the batch never reached because it stopped at the first unknown.
   * Returned explicitly - the caller must not have to set-subtract to learn
   * what was not attempted.
   */
  unattempted: string[];
  quartzEarned: boolean;
};

/**
 * Bulk edit (Product Spec: "bulk edit"), scoped to the operation the Work
 * surface offers: complete. Composes over completeTask one id at a time, so
 * every per-item guard (status, tenant), audit row, settled-edge attribution
 * and Quartz rule applies exactly as if each row's Done was clicked - the
 * bulk path bypasses nothing. Each completion is its own transaction: an id
 * that no longer qualifies (already terminal, or not visible in this
 * workspace) lands in `skipped` and neither rolls back nor silently absorbs
 * the ones that did complete. An unexpected error lands in `unknown` and
 * stops the batch: the completed prefix is real and reported, the failed
 * id's state is honestly uncertain, and nothing past it was attempted.
 * Sequential on purpose: the audit trail's order is the caller's order.
 */
export async function completeTasks(auth: AuthContext, taskIds: string[]): Promise<BulkCompleteOutcome> {
  const outcome: BulkCompleteOutcome = { completed: [], skipped: [], unknown: [], unattempted: [], quartzEarned: false };
  for (const [index, taskId] of taskIds.entries()) {
    let result: Awaited<ReturnType<typeof completeTask>>;
    try {
      result = await completeTask(auth, { taskId });
    } catch {
      outcome.unknown.push(taskId);
      outcome.unattempted = taskIds.slice(index + 1);
      break;
    }
    if (result) {
      outcome.completed.push(result.id);
      outcome.quartzEarned ||= result.quartzEarned;
    } else {
      outcome.skipped.push(taskId);
    }
  }
  return outcome;
}

export type ReopenOutcome =
  | { id: string; from: "done" | "cancelled"; skippedChangedEdges: number }
  | "stale"
  | "not_terminal"
  | null;

export async function reopenTask(
  auth: AuthContext,
  input: { taskId: string; expectedVersion: number },
): Promise<ReopenOutcome> {
  return withTransaction(async (tx) => {
    const [before] = await tx
      .select({ status: tasks.status, version: tasks.version, title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!before) return null;
    if (before.status !== "done" && before.status !== "cancelled") return "not_terminal";
    if (before.version !== input.expectedVersion) return "stale";

    // The row's own guard re-checks status and version inside the UPDATE, so
    // a concurrent reopen or patch between the read and the write loses here.
    const [task] = await tx
      .update(tasks)
      .set({
        status: "ready",
        completedAt: null,
        cancelledAt: null,
        updatedAt: new Date(),
        updatedBy: auth.userId,
        version: sql`${tasks.version} + 1`,
      })
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.workspaceId, auth.workspaceId),
          eq(tasks.version, input.expectedVersion),
          inArray(tasks.status, ["done", "cancelled"]),
        ),
      )
      .returning({ id: tasks.id });
    if (!task) return "stale";

    // Exact attribution: the latest terminal audit event names the edges its
    // transition settled and the version each edge carried right after. An
    // edge is undone only when its CURRENT version still matches that token -
    // any later touch (another resolve, an edit) bumps the version, and a
    // changed edge is refused as ambiguous rather than silently unre-resolved.
    const [terminal] = await tx
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, auth.workspaceId),
          eq(auditEvents.subjectType, "task"),
          eq(auditEvents.subjectId, task.id),
          inArray(auditEvents.action, ["task.completed", "task.updated"]),
          sql`${auditEvents.metadata} -> 'settledEdges' is not null`,
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    const settledEdges = (terminal?.metadata as { settledEdges?: unknown } | null)?.settledEdges;
    const unsettled: string[] = [];
    const skippedChanged: string[] = [];
    if (Array.isArray(settledEdges)) {
      for (const entry of settledEdges) {
        const e = entry as { id?: unknown; version?: unknown };
        if (typeof e.id !== "string" || typeof e.version !== "number") continue;
        const rows = await tx.execute(sql`
          update task_dependencies
             set resolved_at = null, updated_at = now(), updated_by = ${auth.userId},
                 version = version + 1
           where workspace_id = ${auth.workspaceId}
             and id = ${e.id}::uuid
             and version = ${e.version}
             and resolved_at is not null
           returning id`);
        if ((rows as unknown as Array<{ id: string }>).length > 0) unsettled.push(e.id);
        else skippedChanged.push(e.id);
      }
    }

    const from = before.status as "done" | "cancelled";
    await recordAudit(
      auth,
      {
        action: "task.reopened",
        subjectType: "task",
        subjectId: task.id,
        summary: `Reopened task "${before.title}" (was ${from})`,
        metadata: { from, unsettledEdgeIds: unsettled, skippedChangedEdgeIds: skippedChanged },
      },
      tx,
    );
    return { id: task.id, from, skippedChangedEdges: skippedChanged.length };
  });
}
