import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaces } from "@/domains/identity/schema";
import { agentProfiles, agentRuns, runEvents } from "@/domains/agents/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * Feedback is one verdict per assistant message, stored on the run_event the
 * bridge wrote. The same value again clears it; a different value switches;
 * a user message or a missing sequence is not addressable.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let feedback: typeof import("@/domains/agents/feedback");
let auth: AuthContext;
let workspaceId: string;
let runId: string;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  feedback = await import("@/domains/agents/feedback");
  const seeded = await seedWorkspace(db, `run-feedback-${Date.now()}`);
  workspaceId = seeded.workspaceId;
  auth = ownerAuth(seeded.userId, workspaceId);
  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId, name: "alfred", createdBy: seeded.userId, updatedBy: seeded.userId })
    .onConflictDoNothing()
    .returning();
  const profileId = profile?.id ?? (await db.select({ id: agentProfiles.id }).from(agentProfiles).where(eq(agentProfiles.workspaceId, workspaceId)).limit(1))[0].id;
  const [run] = await db
    .insert(agentRuns)
    .values({ workspaceId, agentProfileId: profileId, objective: "feedback test run", policySnapshot: {}, state: "succeeded", createdBy: seeded.userId, updatedBy: seeded.userId })
    .returning();
  runId = run.id;
});

afterAll(async () => {
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await handle?.client.end();
});

async function seedMessage(sequence: number, role: "user" | "assistant", turnId?: string) {
  await db.insert(runEvents).values({
    workspaceId,
    runId,
    sequence,
    type: "message",
    data: { role, content: `message ${sequence}`, ...(turnId ? { turnId } : {}) },
  });
}

// Scoped to this run: sequence numbers repeat across test runs in a shared
// database, so an unscoped sequence match reads a stranger's row.
async function feedbackOf(sequence: number) {
  const [row] = await db
    .select({ feedback: runEvents.feedback })
    .from(runEvents)
    .where(and(eq(runEvents.workspaceId, workspaceId), eq(runEvents.runId, runId), eq(runEvents.sequence, sequence)));
  return row?.feedback ?? null;
}

suite("run message feedback", () => {
  it("stores a verdict on the assistant message event", async () => {
    await seedMessage(1, "user");
    await seedMessage(2, "assistant", "turn-1");
    const result = await feedback.setMessageFeedback(auth, { runId, sequence: 2, feedback: "up" });
    expect(result.ok).toBe(true);
    expect(await feedbackOf(2)).toBe("up");
  });

  it("switches the verdict and clears on the same value again", async () => {
    await feedback.setMessageFeedback(auth, { runId, sequence: 2, feedback: "down" });
    expect(await feedbackOf(2)).toBe("down");
    await feedback.setMessageFeedback(auth, { runId, sequence: 2, feedback: "clear" });
    expect(await feedbackOf(2)).toBeNull();
  });

  it("refuses a user message", async () => {
    const result = await feedback.setMessageFeedback(auth, { runId, sequence: 1, feedback: "up" });
    expect(result.ok).toBe(false);
  });

  it("refuses a sequence outside the run", async () => {
    const result = await feedback.setMessageFeedback(auth, { runId, sequence: 999, feedback: "up" });
    expect(result.ok).toBe(false);
  });

  it("addresses by turnId for the live stream, latest message of the turn", async () => {
    await seedMessage(3, "user", "turn-2");
    await seedMessage(4, "assistant", "turn-2");
    const result = await feedback.setMessageFeedback(auth, { runId, turnId: "turn-2", feedback: "up" });
    expect(result.ok).toBe(true);
    expect(await feedbackOf(4)).toBe("up");
    expect(await feedbackOf(2)).toBeNull(); // turn-1's message untouched
  });

  it("cannot read across workspaces", async () => {
    const seeded = await seedWorkspace(db, `run-feedback-other-${Date.now()}`);
    const other = ownerAuth(seeded.userId, seeded.workspaceId);
    const result = await feedback.setMessageFeedback(other, { runId, sequence: 4, feedback: "down" });
    expect(result.ok).toBe(false);
  });
});
