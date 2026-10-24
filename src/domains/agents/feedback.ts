import { and, desc, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { recordAudit } from "@/domains/audit/record";
import { runEvents } from "./schema";

/*
 * Per-message feedback on a run's thread. The owner's like/dislike lands on
 * the run_event row the message was written to — no second store, no copy of
 * the text. Evaluation reads it with a plain column filter; the thread read
 * passes it through so the UI can render the state it stored.
 *
 * One verdict per message. The same value again clears it: a second click is
 * an undo, not a double vote.
 */

export type MessageFeedback = "up" | "down";

export async function setMessageFeedback(
  auth: AuthContext,
  input: { runId: string; sequence?: number; turnId?: string; feedback: MessageFeedback | "clear" },
): Promise<{ ok: boolean }> {
  // Two addresses for the same row: the stored transcript knows the event
  // sequence; the live stream knows only the blockId, which embeds the turn
  // id the bridge wrote into the event data. The latest assistant message of
  // the turn is the one on screen.
  const conditions = [eq(runEvents.workspaceId, auth.workspaceId), eq(runEvents.runId, input.runId)];
  if (input.sequence !== undefined) {
    conditions.push(eq(runEvents.sequence, input.sequence));
  } else if (input.turnId !== undefined) {
    conditions.push(eq(runEvents.type, "message"), sql`${runEvents.data}->>'turnId' = ${input.turnId}`);
  } else {
    return { ok: false };
  }

  const [event] = await db
    .select({ id: runEvents.id, type: runEvents.type, data: runEvents.data })
    .from(runEvents)
    .where(and(...conditions))
    .orderBy(desc(runEvents.sequence))
    .limit(1);
  if (!event) return { ok: false };
  const data = (event.data ?? {}) as { role?: string };
  if (event.type !== "message" || data.role !== "assistant") return { ok: false };

  const value = input.feedback === "clear" ? null : input.feedback;
  // run_events is append-only (recorded carries createdAt alone); feedback is
  // the one mutable column, and the decision's provenance is the audit row.
  await db.update(runEvents).set({ feedback: value }).where(eq(runEvents.id, event.id));
  await recordAudit(
    auth,
    {
      action: value ? `run.feedback.${value}` : "run.feedback.cleared",
      subjectType: "run",
      subjectId: input.runId,
      summary: value ? `Marked a reply ${value === "up" ? "helpful" : "unhelpful"}` : "Cleared reply feedback",
    },
  );
  return { ok: true };
}
