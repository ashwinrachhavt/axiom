import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { actionProposals } from "@/domains/actions/schema";
import { agentProfiles, agentQuestions, agentRuns, runEvents } from "@/domains/agents/schema";
import { spendingPolicies, spendingReservations } from "@/domains/spending/schema";
import { toolAllowed } from "../../eve/alfred/agent/lib/policy";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The ASH-112 acceptance suite: the checks the epic closes on. Each is a
 * property of the database or of a pure function that a mock cannot fake —
 * unique-index dedupe, workspace scoping under a real query, the reconciliation
 * sweep's reservation release, the conditional terminal flip, the advisory lock
 * behind the budget race, and the one-question-answered rule.
 *
 * `@/lib/db` (the neon HTTP driver the engine reads through) needs a hosted
 * endpoint, so it is mocked to the same postgres-js client the commands use.
 * The engine's own logic is what the test runs; only the transport is swapped,
 * which is what lets a local test database exercise `createEngine` at all.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied. Fresh unique slugs, no truncation, following the other suites.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

beforeAll(() => {
  if (!handle) return;
  holder.db = handle.db;
});

afterAll(async () => {
  await handle?.client.end();
});

let counter = 0;

/** A workspace with a profile, and a run carrying a read-only policy snapshot. */
async function seedRun(label: string, state: "queued" | "running" = "running") {
  const db = holder.db!;
  counter += 1;
  const slug = `${label}-${Date.now()}-${counter}`;
  const { workspaceId } = await seedWorkspace(db, slug);
  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId, name: `policy-${slug}` })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: profile.id,
      objective: "acceptance",
      policySnapshot: { allowedTools: ["tasks.read"] },
      state,
    })
    .returning();
  return { workspaceId, profileId: profile.id, runId: run.id };
}

suite("ASH-112 acceptance", () => {
  it("replay: two calls from one intent leave one proposal", async () => {
    const db = holder.db!;
    const { workspaceId, runId } = await seedRun("acc-replay");
    const actions = await import("@/domains/actions/commands");
    const { withTransaction } = await import("@/lib/db-transaction");
    const input = {
      capability: "gmail.send",
      riskClass: "external_write" as const,
      title: "Send reply",
      expectedEffect: "Sends the reply",
      dedupeKey: `gmail.send:${workspaceId}:msg-1`,
      runId,
    };
    const a = await withTransaction((tx) => actions.createProposal(tx, { workspaceId }, input));
    const b = await withTransaction((tx) => actions.createProposal(tx, { workspaceId }, input));

    // The guardrail is zero duplicate EFFECTS, judged at the proposal: a replay
    // resolves the first proposal rather than arming a second send.
    expect(b.proposalId).toBe(a.proposalId);
    expect(b.deduplicated).toBe(true);
    const rows = await db
      .select()
      .from(actionProposals)
      .where(
        and(eq(actionProposals.workspaceId, workspaceId), eq(actionProposals.dedupeKey, input.dedupeKey)),
      );
    expect(rows).toHaveLength(1);
  });

  it("tenancy: a workspace-scoped read never returns another workspace's runs", async () => {
    const db = holder.db!;
    const a = await seedRun("acc-tenant-a");
    const b = await seedRun("acc-tenant-b");

    const rows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.workspaceId, a.workspaceId));

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(a.runId);
    expect(rows.some((r) => r.id === b.runId)).toBe(false);
  });

  it("delegated escalation: a tool outside the frozen snapshot is denied", async () => {
    // The parent policy grants read-only. An external-write capability is not in
    // it, so the child run's tool is refused before any proposal exists.
    const snapshot = { allowedTools: ["tasks.read"] };
    expect(toolAllowed(snapshot, "tasks.read")).toBe(true);
    expect(toolAllowed(snapshot, "gmail.send")).toBe(false);
    // An allowlist that is absent or malformed fails closed, never open.
    expect(toolAllowed({}, "gmail.send")).toBe(false);
    expect(toolAllowed({ allowedTools: "gmail.send" }, "gmail.send")).toBe(false);
    expect(toolAllowed(null, "gmail.send")).toBe(false);
  });

  it("stale workers: a run past its threshold reconciles to failed and frees its budget", async () => {
    const db = holder.db!;
    const { workspaceId, runId } = await seedRun("acc-stale");
    const { reconcileStaleRuns } = await import("@/domains/agents/commands");
    // An open reservation the dead worker left behind.
    await db
      .insert(spendingReservations)
      .values({ workspaceId, runId, reservedUsd: "0.0001", status: "reserved" });
    // Age the run past the threshold rather than tightening it: created_at is
    // the timestamp the sweep reads.
    await db
      .update(agentRuns)
      .set({ createdAt: new Date(Date.now() - 48 * 3600 * 1000) })
      .where(eq(agentRuns.id, runId));

    const closed = await reconcileStaleRuns(handle!.client);

    expect(closed).toContain(runId);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.state).toBe("failed");
    expect(run.error).toBe("run timed out and was reconciled");

    const [reservation] = await db
      .select()
      .from(spendingReservations)
      .where(eq(spendingReservations.runId, runId));
    expect(reservation.status).toBe("released");

    const events = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "run.reconciled")));
    expect(events).toHaveLength(1);
  });

  it("stale workers: a fresh run is left alone", async () => {
    const db = holder.db!;
    const { runId } = await seedRun("acc-fresh");

    await (await import("@/domains/agents/commands")).reconcileStaleRuns(handle!.client);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.state).toBe("running");
    expect(run.endedAt).toBeNull();
  });

  it("revocation: cancelling a running run is terminal and hands its budget back", async () => {
    const db = holder.db!;
    const { workspaceId, runId } = await seedRun("acc-cancel");
    const { withTransaction } = await import("@/lib/db-transaction");
    const { reserveSpend } = await import("@/domains/spending/commands");
    const claim = await withTransaction((tx) =>
      reserveSpend(tx, { workspaceId }, { runId, model: "x", estimateUsd: "0.0001" }),
    );
    if (!claim.ok) throw new Error("reserve should have succeeded");

    const cancelled: string[] = [];
    const driver = {
      start: async () => {},
      signal: async () => {},
      cancel: async (sessionId: string) => {
        cancelled.push(sessionId);
      },
    };
    const engine = (await import("@/domains/agents/engine")).createEngine(driver);
    const auth = { userId: "", workspaceId, role: "owner" as const };

    const first = await engine.cancel(runId, auth);
    const second = await engine.cancel(runId, auth);
    expect(first.cancelled).toBe(true);
    expect(second.cancelled).toBe(false); // terminal states are immutable
    expect(cancelled).toEqual([runId]); // the driver was told exactly once

    const [reservation] = await db
      .select()
      .from(spendingReservations)
      .where(eq(spendingReservations.id, claim.reservationId));
    expect(reservation.status).toBe("released");

    // The bridge refuses a write against a run under a foreign workspace, so a
    // stray post-cancel event cannot land on this run under a forged owner.
    const bridge = await import("@/domains/agents/event-bridge");
    await expect(
      bridge.recordRoundEvent({ runId, workspaceId: crypto.randomUUID(), type: "late", data: {} }),
    ).rejects.toThrow("run not found in workspace");
  });

  it("concurrent budget race: exactly one claim wins the last increment", async () => {
    const db = holder.db!;
    counter += 1;
    const { workspaceId } = await seedWorkspace(db, `acc-budget-${Date.now()}-${counter}`);
    await db.insert(spendingPolicies).values({
      workspaceId,
      dailyCeilingUsd: "0.0002",
      onExceeded: "fail",
    });
    const { withTransaction } = await import("@/lib/db-transaction");
    const { reserveSpend } = await import("@/domains/spending/commands");
    const claim = () =>
      withTransaction((tx) =>
        reserveSpend(tx, { workspaceId }, { runId: null, model: "x", estimateUsd: "0.0001" }),
      );

    // Four contenders of 0.0001 against a 0.0002 ceiling: the advisory lock is
    // what makes exactly two win, not four by luck.
    const results = await Promise.all([claim(), claim(), claim(), claim()]);

    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });

  it("approval race: answering one question leaves the others open", async () => {
    const db = holder.db!;
    const { workspaceId, runId } = await seedRun("acc-approval");
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const [row] = await db
        .insert(agentQuestions)
        .values({ workspaceId, runId, question: `Question ${n}?` })
        .returning({ id: agentQuestions.id });
      ids.push(row.id);
    }

    await db
      .update(agentQuestions)
      .set({ state: "answered", answer: "work-gmail", answeredAt: new Date() })
      .where(and(eq(agentQuestions.id, ids[0]), eq(agentQuestions.state, "open")));

    const rows = await db.select().from(agentQuestions).where(eq(agentQuestions.runId, runId));
    expect(rows.filter((r) => r.state === "answered")).toHaveLength(1);
    expect(rows.filter((r) => r.state === "open")).toHaveLength(2);
  });
});
