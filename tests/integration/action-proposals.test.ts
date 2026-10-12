import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionProposals } from "@/domains/actions/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * `createProposal` is the single write path that turns model intent into an
 * external effect, so its invariant is the product's hardest guardrail: zero
 * duplicate external effects. The dedupe key is `(workspace_id, dedupe_key)`,
 * unique in the database — a replayed run resolves the existing proposal rather
 * than creating a second row, and a mock cannot show that. Only real Postgres
 * can prove the conflict target wins the race.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied. The commands and the transaction wrapper are imported lazily and
 * only after DATABASE_URL is pointed at that same database: src/lib/db-transaction.ts
 * reads DATABASE_URL at module load, so a static import would resolve against
 * the wrong database (or throw without one) and fail this file instead of
 * skipping it.
 *
 * The seed/truncate scaffolding lives in tests/helpers/test-workspace.ts;
 * this file inserts fresh unique slugs and truncates nothing.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let actions: typeof import("@/domains/actions/commands");
let withTransaction: typeof import("@/lib/db-transaction").withTransaction;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  actions = await import("@/domains/actions/commands");
  ({ withTransaction } = await import("@/lib/db-transaction"));
});

afterAll(async () => {
  await handle?.client.end();
});

let seedCounter = 0;

async function seed(label: string) {
  seedCounter += 1;
  const { workspaceId } = await seedWorkspace(db, `${label}-${Date.now()}-${seedCounter}`);
  return workspaceId;
}

const propose = (
  workspaceId: string,
  input: Omit<Parameters<typeof actions.createProposal>[2], "dedupeKey"> & {
    dedupeKey: string;
  },
) => withTransaction((tx) => actions.createProposal(tx, { workspaceId }, input));

suite("createProposal", () => {
  it("replaying a dedupe key yields one proposal row, never a second effect", async () => {
    const workspaceId = await seed("proposal-replay");
    const input = {
      capability: "gmail.send",
      riskClass: "external_write" as const,
      title: "Send reply to Priya",
      expectedEffect: "Sends the drafted reply",
      dedupeKey: `gmail.send:${workspaceId}:msg-123`,
      runId: null,
    };

    const a = await propose(workspaceId, input);
    const b = await propose(workspaceId, input);

    expect(a.deduplicated).toBe(false);
    expect(b.proposalId).toBe(a.proposalId);
    expect(b.deduplicated).toBe(true);

    const rows = await db
      .select()
      .from(actionProposals)
      .where(
        and(
          eq(actionProposals.workspaceId, workspaceId),
          eq(actionProposals.dedupeKey, input.dedupeKey),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("concurrent replays of one dedupe key still land one row", async () => {
    const workspaceId = await seed("proposal-conc");
    const input = {
      capability: "gmail.send",
      riskClass: "external_write" as const,
      title: "Send reply",
      expectedEffect: "Sends it",
      dedupeKey: `gmail.send:${workspaceId}:msg-conc`,
      runId: null,
    };

    // The unique index, not application timing, is what makes this hold.
    const results = await Promise.all([propose(workspaceId, input), propose(workspaceId, input), propose(workspaceId, input)]);

    expect(new Set(results.map((r) => r.proposalId)).size).toBe(1);
    expect(results.filter((r) => r.deduplicated)).toHaveLength(2);

    const rows = await db
      .select()
      .from(actionProposals)
      .where(eq(actionProposals.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
  });

  it("the same dedupe key in another workspace is a different proposal", async () => {
    const a = await seed("proposal-scope-a");
    const b = await seed("proposal-scope-b");
    const shared = { capability: "gmail.send", riskClass: "external_write" as const, title: "x", expectedEffect: "y", runId: null, dedupeKey: "shared-key" };

    const pa = await propose(a, shared);
    const pb = await propose(b, shared);

    expect(pb.proposalId).not.toBe(pa.proposalId);
    expect(pb.deduplicated).toBe(false);
  });

  it("persists a prepare risk class with an already-past expiry", async () => {
    const workspaceId = await seed("proposal-expiry");
    const past = new Date(Date.now() - 1000);
    const { proposalId } = await propose(workspaceId, {
      capability: "gmail.draft",
      riskClass: "prepare",
      title: "Draft reply",
      expectedEffect: "A draft exists in Reviews",
      dedupeKey: `gmail.draft:${workspaceId}:msg-exp`,
      runId: null,
      expiresAt: past,
    });

    const [row] = await db
      .select()
      .from(actionProposals)
      .where(eq(actionProposals.id, proposalId));
    expect(row.riskClass).toBe("prepare");
    expect(row.status).toBe("pending");
    // Expiry adjustment is a later concern; the column round-trips now.
    expect(row.expiresAt?.getTime()).toBe(past.getTime());
  });
});
