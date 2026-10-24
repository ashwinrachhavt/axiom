"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import { IdempotencyConflictError } from "@/domains/audit/receipt";
import { completeTask, completeTasks, reopenTask, createOwnerTask } from "@/domains/work/commands";
import { getCompletionConflictState } from "@/domains/work/queries";
import {
  DependencyCycleError,
  RankOrderError,
  SubtaskDepthError,
  TaskNotFoundError,
  VersionConflictError,
  addDependency,
  createSubtask,
  moveTask,
  removeDependency,
  updateTask,
} from "@/domains/work/task-commands";
import {
  abandonFocusSession,
  ConflictError as FocusConflictError,
  finishFocusSession,
  pauseFocusSession,
  resumeFocusSession,
  StaleWriteError as FocusStaleWriteError,
  startFocusSession,
} from "@/domains/focus/commands";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { focusTag, tasksTag } from "@/lib/cache-tags";

/*
 * Work mutations. Both write the canonical `tasks` row — the same one
 * obligation acceptance writes — which is the whole point: a task created in
 * document review appears here, and completing it here is visible to every
 * other reader of that row.
 */

const revalidate = (auth: AuthContext) => {
  updateTag(tasksTag(auth));
  revalidatePath("/neuralflow/work");
};

const revalidateFocus = (auth: AuthContext) => {
  updateTag(focusTag(auth));
  revalidatePath("/neuralflow/work");
};

/*
 * Every action below writes the canonical tasks row, so each requires member
 * or above - a viewer's quick complete is still a write (ASH-121 AC05).
 */
async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

const createInput = z.object({
  title: z.string().trim().min(1).max(300),
  rationale: z.string().trim().max(500, "Keep the reason under 500 characters.").optional(),
  dueAt: z.coerce.date().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  estimateMinutes: z.number().int().min(1).max(1440).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  personId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
  idempotencyKey: z.string().uuid().optional(),
});

export async function createTaskAction(input: {
  title: string;
  rationale?: string;
  dueAt?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  estimateMinutes?: number;
  tags?: string[];
  personId?: string;
  organizationId?: string;
  idempotencyKey?: string;
}): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the task a title." };

  const auth = await authorize();
  const { id } = await createOwnerTask(auth, parsed.data);
  revalidate(auth);
  return { ok: true, taskId: id };
}

const completionSentence = z
  .string()
  .trim()
  .max(280, "Keep the sentence under 280 characters.")
  .optional();

export type CompleteTaskResult =
  | { ok: true; quartzEarned: boolean }
  // conflict: the task's real state already moved on - retrying the
  // completion is wrong, the list should reconcile instead. sentenceRecorded
  // is set only when a sentence was submitted AND the completed task's audit
  // row was checked: true = this exact sentence is on the recorded
  // completion, false = it is not; unset = nothing claimed. validation: the
  // sentence itself was rejected; editing and resubmitting is right.
  | { ok: false; kind: "conflict" | "validation"; error: string; sentenceRecorded?: boolean };

export async function completeTaskAction(
  taskId: string,
  sentence?: string,
): Promise<CompleteTaskResult> {
  const parsed = z.string().uuid().safeParse(taskId);
  if (!parsed.success) return { ok: false, kind: "conflict", error: "That task no longer exists." };
  const noted = completionSentence.safeParse(sentence);
  if (!noted.success) return { ok: false, kind: "validation", error: noted.error.issues[0]?.message ?? "That sentence is too long." };

  const auth = await authorize();
  const done = await completeTask(auth, { taskId: parsed.data, sentence: noted.data });
  revalidate(auth);
  if (done) return { ok: true, quartzEarned: done.quartzEarned };

  // The guarded UPDATE matched no row. Find out why before saying anything:
  // a cancelled or inaccessible task is not "already completed", and when a
  // response was lost after commit, this request's sentence may actually be
  // recorded - check the completed task's audit row before claiming either.
  const state = await getCompletionConflictState(auth, parsed.data);
  if (!state) return { ok: false, kind: "conflict", error: "That task is not available in this workspace." };
  if (state.status === "cancelled") return { ok: false, kind: "conflict", error: "That task was cancelled, not completed." };
  if (state.status !== "done") return { ok: false, kind: "conflict", error: "That task could not be completed. Reload to see its current state." };
  const submitted = noted.data;
  if (submitted) {
    return state.completionNote === submitted
      ? { ok: false, kind: "conflict", error: "This task was already completed - with this sentence recorded.", sentenceRecorded: true }
      : { ok: false, kind: "conflict", error: "This task was already completed.", sentenceRecorded: false };
  }
  return { ok: false, kind: "conflict", error: "This task was already completed." };
}

/*
 * Bulk edit (Product Spec: "bulk edit"). Completes each selected task through
 * the same guarded command the single Done button uses and reports the
 * outcome per item: nothing is shown as done that did not complete, and a
 * task that was already terminal or left the workspace is named as skipped,
 * not absorbed. No per-item sentence - the completion question stays a
 * single-task affordance; completing with no sentence is the same "Just
 * complete" the row button already offers.
 */
const bulkCompleteInput = z.array(z.string().uuid()).min(1).max(100);

export async function completeTasksAction(
  taskIds: string[],
): Promise<{ ok: true; completed: string[]; skipped: string[]; unknown: string[]; unattempted: string[]; quartzEarned: boolean } | { ok: false; error: string }> {
  const parsed = bulkCompleteInput.safeParse(taskIds);
  if (!parsed.success) return { ok: false, error: "Select between 1 and 100 tasks." };

  const auth = await authorize();
  const outcome = await completeTasks(auth, [...new Set(parsed.data)]);
  revalidate(auth);
  return { ok: true, ...outcome };
}

/*
 * Undo a terminal transition (Product Spec: "Undo for every terminal
 * transition"). A completed or cancelled task comes back as `ready`. The
 * earned stone and the audit history stand - reopening reopens the task,
 * it does not rewrite what happened.
 */
export async function reopenTaskAction(
  taskId: string,
  expectedVersion: number,
): Promise<{ ok: true; from: "done" | "cancelled"; note: string | null } | { ok: false; error: string }> {
  const parsed = z.string().uuid().safeParse(taskId);
  if (!parsed.success || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { ok: false, error: "That task no longer exists." };
  }

  const auth = await authorize();
  const reopened = await reopenTask(auth, { taskId: parsed.data, expectedVersion });
  revalidate(auth);
  if (reopened && reopened !== "stale" && reopened !== "not_terminal") {
    // Scoped undo, said out loud: an edge that changed since the completion
    // is left exactly as it is, and the user hears that.
    const note =
      reopened.skippedChangedEdges > 0
        ? `Reopened. ${reopened.skippedChangedEdges} blocker link${reopened.skippedChangedEdges === 1 ? "" : "s"} changed since completion and ${reopened.skippedChangedEdges === 1 ? "was" : "were"} left as-is.`
        : null;
    return { ok: true, from: reopened.from, note };
  }
  if (reopened === "stale") {
    // ABA defense: the view saw an older transition. Undoing it would revert
    // a newer reopen-and-recomplete the clicker never saw.
    return { ok: false, error: "This task changed since you loaded it. Reload to see the latest." };
  }
  if (reopened === "not_terminal") return { ok: false, error: "Only a completed or cancelled task can be reopened." };
  return { ok: false, error: "That task no longer exists." };
}

/*
 * Task-graph mutations (A03). Each takes the idempotency key the client minted
 * for this user intent and the version it last saw; a stale version or a
 * dependency cycle comes back as a message, not a thrown error.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const domainErrors = [
  TaskNotFoundError,
  VersionConflictError,
  DependencyCycleError,
  SubtaskDepthError,
  RankOrderError,
  IdempotencyConflictError,
];

async function guarded<T extends object>(auth: AuthContext, run: () => Promise<T>): Promise<Result<T>> {
  try {
    const value = await run();
    revalidate(auth);
    return { ok: true, ...value };
  } catch (error) {
    if (domainErrors.some((E) => error instanceof E)) return { ok: false, error: (error as Error).message };
    throw error;
  }
}

const key = z.string().uuid();
const id = z.string().uuid();

const patchInput = z.object({
  taskId: id,
  expectedVersion: z.number().int().min(1),
  idempotencyKey: key,
  patch: z
    .object({
      title: z.string().trim().min(1).max(300),
      description: z.string().max(20_000).nullable(),
      rationale: z.string().trim().max(500, "Keep the reason under 500 characters.").nullable(),
      status: z.enum(["inbox", "backlog", "ready", "in_progress", "waiting", "done", "cancelled"]),
      priority: z.enum(["none", "low", "medium", "high", "urgent"]),
      dueAt: z.string().datetime().nullable(),
      estimateMinutes: z.number().int().min(0).max(100_000).nullable(),
      tags: z.array(z.string().trim().min(1).max(60)).max(30),
    })
    .partial()
    .refine((p) => Object.keys(p).length > 0, "Nothing to change."),
});

export async function updateTaskAction(input: z.input<typeof patchInput>): Promise<Result<{ version: number }>> {
  const parsed = patchInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the task fields and try again." };
  const auth = await authorize();
  return guarded(auth, async () => ({ version: (await updateTask(auth, parsed.data)).version }));

}

const subtaskInput = z.object({ parentTaskId: id, title: z.string().trim().min(1).max(300), idempotencyKey: key });

export async function createSubtaskAction(input: z.input<typeof subtaskInput>): Promise<Result<{ taskId: string }>> {
  const parsed = subtaskInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the subtask a title." };
  const auth = await authorize();
  return guarded(auth, async () => ({ taskId: (await createSubtask(auth, parsed.data)).id }));

}

const moveInput = z.object({
  taskId: id,
  expectedVersion: z.number().int().min(1),
  afterTaskId: id.optional(),
  beforeTaskId: id.optional(),
  idempotencyKey: key,
});

export async function moveTaskAction(input: z.input<typeof moveInput>): Promise<Result<{ rank: string; version: number }>> {
  const parsed = moveInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That move is not valid." };
  const auth = await authorize();
  return guarded(auth, async () => {

    const { rank, version } = await moveTask(auth, parsed.data);
    return { rank, version };
  });
}

const dependencyInput = z.object({
  taskId: id,
  otherTaskId: id,
  kind: z.enum(["blocks", "blocked_by"]),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: key,
});

export async function addDependencyAction(input: z.input<typeof dependencyInput>): Promise<Result<{ dependencyId: string }>> {
  const parsed = dependencyInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That dependency is not valid." };
  const auth = await authorize();
  return guarded(auth, async () => ({ dependencyId: (await addDependency(auth, parsed.data)).id }));

}

export async function removeDependencyAction(input: { dependencyId: string; idempotencyKey: string }): Promise<Result> {
  const parsed = z.object({ dependencyId: id, idempotencyKey: key }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That dependency no longer exists." };
  const auth = await authorize();
  return guarded(auth, async () => {

    await removeDependency(auth, parsed.data);
    return {};
  });
}

/*
 * Focus-session lifecycle (the retired Focus surface's actions, hosted here so
 * a session starts, pauses, resumes, and finishes from Work). Every
 * transition carries the version the caller rendered; a stale version is a
 * user-safe error, never a silent overwrite. The server owns the clock -
 * clients send intents, not timestamps.
 */

function focusFail(error: unknown): FocusResult {
  if (error instanceof FocusStaleWriteError || error instanceof FocusConflictError) {
    return { ok: false, error: error.message };
  }
  throw error;
}

type FocusResult = { ok: true } | { ok: false; error: string };

const focusTransitionInput = z.object({
  sessionId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().max(200).optional().default(""),
  outcome: z.string().trim().max(500).optional().default(""),
  whatChanged: z.string().trim().max(500).optional().default(""),
  nextStep: z.string().trim().max(500).optional().default(""),
});

export async function startSessionAction(input: unknown): Promise<FocusResult> {
  const parsed = z
    .object({
      subject: z.string().trim().max(200).optional().default(""),
      plannedMinutes: z.number().int().min(1).max(480).nullable(),
      taskId: z.string().uuid().optional(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the session and try again." };
  }
  if (!parsed.data.taskId && !parsed.data.subject) {
    return { ok: false, error: "Name what you are focusing on." };
  }
  const auth = await authorize();
  try {
    await startFocusSession(auth, {
      subject: parsed.data.subject || null,
      plannedMinutes: parsed.data.plannedMinutes,
      taskId: parsed.data.taskId ?? null,
    });
  } catch (error) {
    return focusFail(error);
  }
  revalidateFocus(auth);
  return { ok: true };
}

export async function pauseSessionAction(input: unknown): Promise<FocusResult> {
  const parsed = focusTransitionInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Reload and try again." };
  const auth = await authorize();
  try {
    await pauseFocusSession(auth, { ...parsed.data, reason: parsed.data.reason || null });
  } catch (error) {
    return focusFail(error);
  }
  revalidateFocus(auth);
  return { ok: true };
}

export async function resumeSessionAction(input: unknown): Promise<FocusResult> {
  const parsed = focusTransitionInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Reload and try again." };
  const auth = await authorize();
  try {
    await resumeFocusSession(auth, parsed.data);
  } catch (error) {
    return focusFail(error);
  }
  revalidateFocus(auth);
  return { ok: true };
}

export async function finishSessionAction(input: unknown): Promise<FocusResult> {
  const parsed = focusTransitionInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Reload and try again." };
  const auth = await authorize();
  try {
    await finishFocusSession(auth, { ...parsed.data, outcome: parsed.data.outcome || null, whatChanged: parsed.data.whatChanged || null, nextStep: parsed.data.nextStep || null });
  } catch (error) {
    return focusFail(error);
  }
  revalidateFocus(auth);
  return { ok: true };
}

export async function abandonSessionAction(input: unknown): Promise<FocusResult> {
  const parsed = focusTransitionInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Reload and try again." };
  const auth = await authorize();
  try {
    await abandonFocusSession(auth, { ...parsed.data, reason: parsed.data.reason || null });
  } catch (error) {
    return focusFail(error);
  }
  revalidateFocus(auth);
  return { ok: true };
}
