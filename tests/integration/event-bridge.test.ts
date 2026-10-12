import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProfiles, agentRuns, agentQuestions, messages, runEvents, toolCalls } from "@/domains/agents/schema";
import { spendingReservations } from "@/domains/spending/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The bridge's invariants, against real Postgres: the per-run sequence claim
 * holds under concurrent writers, a replayed hook dedupes, secrets never reach
 * a column, the transcript mirrors with `runId` set, and the terminal close
 * flips the state and settles the reservation from the accumulated usage.
 *
 * None of this is provable against a mock — the advisory lock, the
 * `(run_id, sequence)` conflict target, `numeric` summation, and the conditional
 * state flip are all properties of the database.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied. The bridge pulls in src/lib/db-transaction.ts, which reads
 * DATABASE_URL at module load, so the module is imported lazily and only after
 * DATABASE_URL points at that same database — a static import would resolve
 * against the wrong database (or throw without one) and fail instead of skip.
 *
 * The workspace seed scaffolding lives in tests/helpers/test-workspace.ts; the
 * profile+run seed below is specific to this suite and stays here.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let bridge: typeof import("@/domains/agents/event-bridge");
let commands: typeof import("@/domains/spending/commands");
let withTransaction: typeof import("@/lib/db-transaction").withTransaction;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  bridge = await import("@/domains/agents/event-bridge");
  commands = await import("@/domains/spending/commands");
  ({ withTransaction } = await import("@/lib/db-transaction"));
});

afterAll(async () => {
  await handle?.client.end();
});

let seedCounter = 0;

/** A workspace, profile, and run each test owns outright — no shared fixtures. */
async function seedRun(label: string) {
  seedCounter += 1;
  const slug = `${label}-${Date.now()}-${seedCounter}`;
  const { userId, workspaceId } = await seedWorkspace(db, slug);
  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId, name: `bridge-${slug}` })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: profile.id,
      objective: "test",
      policySnapshot: {},
      state: "running",
    })
    .returning();
  return { workspaceId, userId, runId: run.id };
}

suite("event bridge", () => {
  it("sequences advance monotonically and a replayed event is a no-op", async () => {
    const { workspaceId, runId } = await seedRun("bridge-seq");

    const a = await bridge.recordRoundEvent({
      runId,
      workspaceId,
      type: "step.started",
      data: { turnId: "t1", stepIndex: 0 },
    });
    const b = await bridge.recordRoundEvent({
      runId,
      workspaceId,
      type: "step.completed",
      data: { turnId: "t1", stepIndex: 0 },
    });
    // The identical delivery eve's at-least-once hooks produce on a resumed step.
    const replay = await bridge.recordRoundEvent({
      runId,
      workspaceId,
      type: "step.completed",
      data: { turnId: "t1", stepIndex: 0 },
    });

    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(a.sequence + 1);
    expect(replay).toEqual({ sequence: b.sequence, deduplicated: true });

    const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sequence).sort((x, y) => x - y)).toEqual([1, 2]);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.lastEventSeq).toBe(b.sequence);
  });

  it("concurrent writers cannot claim the same sequence", async () => {
    const { workspaceId, runId } = await seedRun("bridge-conc");

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        bridge.recordRoundEvent({
          runId,
          workspaceId,
          type: "turn.started",
          data: { turnId: `turn-${i}` },
        }),
      ),
    );

    const sequences = results.map((r) => r.sequence);
    expect(new Set(sequences).size).toBe(12);
    expect([...sequences].sort((x, y) => x - y)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.lastEventSeq).toBe(12);
  });

  it("a cancelled turn is a timeline event and never closes the run", async () => {
    // eve documents turn.cancelled as non-terminal: the session takes the next
    // message. A cancelled turn must not flip the run, stamp endedAt, or settle.
    const { workspaceId, runId } = await seedRun("bridge-turn-cancel");

    const event = await bridge.recordRoundEvent({
      runId,
      workspaceId,
      type: "turn.cancelled",
      data: { turnId: "t1" },
    });
    expect(event.deduplicated).toBe(false);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.state).toBe("running");
    expect(run.endedAt).toBeNull();
  });

  it("refuses a run that belongs to another workspace", async () => {
    // Guards against a caller passing a run id from a workspace it does not own.
    const owner = await seedRun("bridge-owner");
    const other = await seedRun("bridge-other");
    await expect(
      bridge.recordRoundEvent({
        runId: owner.runId,
        workspaceId: other.workspaceId,
        type: "step.started",
        data: { at: "x" },
      }),
    ).rejects.toThrow(/workspace/);
    // The wrong-workspace tool call and question likewise write nothing.
    await expect(
      bridge.recordToolCall({
        workspaceId: other.workspaceId,
        runId: owner.runId,
        toolName: "gmail.send",
        ok: true,
      }),
    ).rejects.toThrow(/workspace/);
    await expect(
      bridge.recordQuestion({
        workspaceId: other.workspaceId,
        runId: owner.runId,
        question: "?",
      }),
    ).rejects.toThrow(/workspace/);

    const events = await db.select().from(runEvents).where(eq(runEvents.runId, owner.runId));
    expect(events).toHaveLength(0);
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.runId, owner.runId));
    expect(calls).toHaveLength(0);
    const questions = await db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.runId, owner.runId));
    expect(questions).toHaveLength(0);
  });

  it("stores tool call arguments and results redacted", async () => {
    const { workspaceId, runId } = await seedRun("bridge-tool");

    await bridge.recordToolCall({
      workspaceId,
      runId,
      toolName: "gmail.send",
      ok: true,
      durationMs: 42,
      args: {
        to: "x@y.com",
        token: "sk-secret-123",
        nested: { apiKey: "sk-secret-999", keep: "visible" },
      },
      result: { ok: true, authorization: "Bearer sk-secret-456" },
    });

    const rows = await db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.workspaceId, workspaceId), eq(toolCalls.runId, runId)));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("sk-secret");
    expect(rows[0].arguments).toEqual({
      to: "x@y.com",
      token: "[redacted]",
      nested: { apiKey: "[redacted]", keep: "visible" },
    });
    expect(rows[0].result).toEqual({ ok: true, authorization: "[redacted]" });
  });

  it("mirrors the transcript and reuses the run's thread", async () => {
    const { workspaceId, runId } = await seedRun("bridge-msg");

    await bridge.mirrorMessage({
      workspaceId,
      runId,
      role: "user",
      content: "What is on my plate?",
    });
    await bridge.mirrorMessage({
      workspaceId,
      runId,
      role: "assistant",
      content: "Three things.",
    });

    const rows = await db.select().from(messages).where(eq(messages.runId, runId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.threadId)).toBe(true);
    // One thread for both messages, and it is the one the run now owns.
    expect(new Set(rows.map((r) => r.threadId)).size).toBe(1);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.threadId).toBe(rows[0].threadId);
  });

  it("records a question as a row plus a timeline event", async () => {
    const { workspaceId, runId } = await seedRun("bridge-q");

    await bridge.recordQuestion({
      workspaceId,
      runId,
      question: "Which account should send this?",
      context: "two connected gmail accounts",
      options: [{ id: "work-gmail", label: "work-gmail" }],
    });

    const questions = await db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.runId, runId));
    expect(questions).toHaveLength(1);
    expect(questions[0].state).toBe("open");

    const events = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "question.opened")));
    expect(events).toHaveLength(1);
  });

  it("close settles the reservation from accumulated usage, once", async () => {
    const { workspaceId, runId } = await seedRun("bridge-close");
    const claim = await withTransaction((tx) =>
      commands.reserveSpend(
        tx,
        { workspaceId },
        { runId, model: "claude-sonnet-4-6", estimateUsd: "0.500000" },
      ),
    );
    if (!claim.ok) throw new Error("reserve should have succeeded");

    await bridge.recordUsageEvent({
      workspaceId,
      runId,
      usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 5 },
      source: { turnId: "t1", stepIndex: 0 },
    });
    // Same tokens, different step: two rows, not a dedupe.
    await bridge.recordUsageEvent({
      workspaceId,
      runId,
      usage: { costUsd: 0.05, inputTokens: 10, outputTokens: 5 },
      source: { turnId: "t1", stepIndex: 1 },
    });

    const first = await bridge.closeRun({
      workspaceId,
      runId,
      state: "succeeded",
      summary: "Summarized the inbox.",
    });
    expect(first.closed).toBe(true);
    expect(Number(first.settledUsd)).toBeCloseTo(0.3, 6);

    // Terminal states are immutable: a second close writes nothing, settles nothing.
    const second = await bridge.closeRun({ workspaceId, runId, state: "failed" });
    expect(second).toEqual({ closed: false, settledUsd: null });

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.state).toBe("succeeded");
    expect(run.endedAt).not.toBeNull();
    expect(run.lastEventSeq).toBe(3); // two usage events + run.succeeded

    const [reservation] = await db
      .select()
      .from(spendingReservations)
      .where(eq(spendingReservations.id, claim.reservationId));
    expect(reservation.status).toBe("settled");
    expect(Number(reservation.settledUsd)).toBeCloseTo(0.3, 6);

    const terminal = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), inArray(runEvents.type, ["run.succeeded"])));
    expect(terminal).toHaveLength(1);
  });
});
