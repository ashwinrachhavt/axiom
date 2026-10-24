import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { createEngine } from "./engine";
import { createEveDriver, SessionNotActiveError } from "./eve-driver";
import { recordRoundEvent } from "./event-bridge";
import { agentRuns, runEvents } from "./schema";

/*
 * A run's thread is its run_events, read in sequence order. The first event is
 * the objective as a user message (written by the engine at start), assistant
 * replies and follow-ups are appended as `message` events, and a cancel writes
 * a `cancelled` event. Nothing is held in the browser, so a reload reads the
 * same thread back from listRecentRuns plus these events.
 */

export type ThreadEntry = {
  sequence: number;
  kind: "user" | "assistant" | "reasoning" | "cancelled" | "status";
  text: string;
  at: Date;
  /** The owner's like/dislike on an assistant message; null when not given. */
  feedback?: "up" | "down" | null;
};

const TERMINAL = ["succeeded", "failed", "cancelled"] as const;
export const isFinished = (state: string) => (TERMINAL as readonly string[]).includes(state);

function toEntry(row: { sequence: number; type: string; data: unknown; createdAt: Date; feedback?: string | null }): ThreadEntry | null {
  const data = (row.data ?? {}) as { role?: string; content?: unknown; detail?: unknown; text?: unknown };
  if (row.type === "message" && typeof data.content === "string") {
    return {
      sequence: row.sequence,
      kind: data.role === "assistant" ? "assistant" : "user",
      text: data.content,
      at: row.createdAt,
      feedback: data.role === "assistant" ? ((row.feedback as "up" | "down" | null) ?? null) : undefined,
    };
  }
  // The model's visible rationale, persisted by the bridge so a reload keeps
  // what the live stream already showed.
  if (row.type === "reasoning" && typeof data.text === "string" && data.text.trim() !== "") {
    return { sequence: row.sequence, kind: "reasoning", text: data.text, at: row.createdAt };
  }
  if (row.type === "cancelled") return { sequence: row.sequence, kind: "cancelled", text: "Cancelled", at: row.createdAt };
  if (row.type === "step.failed") {
    return { sequence: row.sequence, kind: "status", text: "A step failed", at: row.createdAt };
  }
  if (row.type === "compaction") {
    return {
      sequence: row.sequence,
      kind: "status",
      text: "Earlier turns were summarized to keep the conversation in the model's window.",
      at: row.createdAt,
    };
  }
  return null; // usage, session lifecycle and the rest are not thread content
}

/** The visible thread of each run, keyed by run id, scoped to the workspace. */
export async function listThreads(workspaceId: string, runIds: string[]): Promise<Map<string, ThreadEntry[]>> {
  const out = new Map<string, ThreadEntry[]>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select({ runId: runEvents.runId, sequence: runEvents.sequence, type: runEvents.type, data: runEvents.data, createdAt: runEvents.createdAt, feedback: runEvents.feedback })
    .from(runEvents)
    .where(and(eq(runEvents.workspaceId, workspaceId), inArray(runEvents.runId, runIds)))
    .orderBy(asc(runEvents.runId), asc(runEvents.sequence));
  for (const row of rows) {
    const entry = toEntry(row);
    if (entry) out.set(row.runId, [...(out.get(row.runId) ?? []), entry]);
  }
  return out;
}

export type FollowUpResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "run_finished" | "empty"; message: string };

/**
 * A follow-up on a live run: persisted first, then signalled to Eve. A finished
 * run rejects it (retry makes a new run instead), and so does a run in another
 * workspace, with the same not_found as a missing one.
 */
export async function sendFollowUp(auth: AuthContext, runId: string, text: string): Promise<FollowUpResult> {
  const content = text.trim();
  if (!content) return { ok: false, code: "empty", message: "Write a message first." };
  const [run] = await db
    .select({ id: agentRuns.id, state: agentRuns.state })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!run) return { ok: false, code: "not_found", message: "No such run." };
  if (isFinished(run.state)) {
    return { ok: false, code: "run_finished", message: "This run is finished. Retry it to start a new run." };
  }
  await recordRoundEvent({ runId, workspaceId: auth.workspaceId, type: "message", data: { role: "user", content } });
  try {
    await createEngine(createEveDriver()).signal(runId, content, auth);
  } catch (cause) {
    // The engine has already closed a run whose session died; the person's
    // message is kept in run_events. Answer 409 so the surface tells them to
    // retry (a new run) instead of a bare 500 that reads as "their" failure.
    if (cause instanceof SessionNotActiveError) {
      return { ok: false, code: "run_finished", message: "This conversation's session ended. Retry it to continue in a new run." };
    }
    throw cause;
  }
  return { ok: true };
}

export type RetryResult =
  | { ok: true; runId: string }
  | { ok: false; code: "not_found" | "run_active"; message: string };

/** Retry creates a NEW run id from a finished run's objective; the old thread is left as it was. */
export async function retryRun(auth: AuthContext, runId: string): Promise<RetryResult> {
  const [run] = await db
    .select({
      state: agentRuns.state,
      objective: agentRuns.objective,
      subjects: agentRuns.subjects,
      policySnapshot: agentRuns.policySnapshot,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!run) return { ok: false, code: "not_found", message: "No such run." };
  if (!isFinished(run.state)) {
    return { ok: false, code: "run_active", message: "This run is still active. Cancel it or wait for it to finish." };
  }
  // A retry must run under the same skill as the run it replaces; dropping the
  // pin would silently change what the agent is told while the history still
  // presents the two runs as one thread.
  const pinnedSkillId = (run.policySnapshot as { skill?: { id?: unknown } } | null)?.skill?.id;
  const { runId: next } = await createEngine(createEveDriver()).start({
    auth,
    profileName: "alfred",
    objective: run.objective,
    subjects: Array.isArray(run.subjects) ? run.subjects : [],
    estimateUsd: "0.50",
    retryOfRunId: runId,
    skillId: typeof pinnedSkillId === "string" ? pinnedSkillId : undefined,
  });
  return { ok: true, runId: next };
}

/** Newest run first, for tests and callers that need the latest thread. */
export async function latestRunId(workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.workspaceId, workspaceId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return row?.id ?? null;
}
