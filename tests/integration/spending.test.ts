import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  spendingPolicies,
  spendingReservations,
  spendSettlements,
} from "@/domains/spending/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The spending invariants agents/engineering.md says run against real Postgres,
 * because a mock proves the mock works. The ceiling has to hold when claims run
 * at once, settle has to be idempotent, and the per-run ceiling has to fire —
 * none of which a mock can show.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied. The commands and the transaction wrapper are imported lazily and
 * only after DATABASE_URL is pointed at that same database: src/lib/db-transaction.ts
 * reads DATABASE_URL at module load, so a static import would resolve against
 * the wrong database (or throw without one) and fail this file instead of
 * skipping it.
 *
 * The seed scaffolding lives in tests/helpers/test-workspace.ts; this file
 * inserts fresh unique slugs and truncates nothing.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/spending/commands");
let withTransaction: typeof import("@/lib/db-transaction").withTransaction;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/spending/commands");
  ({ withTransaction } = await import("@/lib/db-transaction"));
});

afterAll(async () => {
  await handle?.client.end();
});

const TINY = "0.000001";

/*
 * `dailyCeilingUsd` and `perRunCeilingUsd` are numeric(12,4) — four decimal
 * places. The brief's "0.000003" rounds to 0.0000 on the way in, so every claim
 * is rejected and a test that only counts results passes without proving
 * anything. These values survive a round trip, and the ceiling is one estimate
 * wide so exactly one of four contenders can win.
 */
const DAILY = "0.0001";
const PER_RUN = "0.0001";
const ESTIMATE = "0.0001";

async function seedWs(slug: string, daily?: string, perRun?: string) {
  const { workspaceId } = await seedWorkspace(db, slug);
  await db.insert(spendingPolicies).values({
    workspaceId,
    dailyCeilingUsd: daily ?? null,
    perRunCeilingUsd: perRun ?? null,
    onExceeded: "fail",
  });
  return { workspaceId };
}

suite("spending commands", () => {
  it("reserve respects the daily ceiling across concurrent claims", async () => {
    const ws = await seedWs(`spend-conc-${Date.now()}`, DAILY);
    const claim = () =>
      withTransaction((tx) =>
        commands.reserveSpend(
          tx,
          { workspaceId: ws.workspaceId },
          { runId: null, model: "x", estimateUsd: ESTIMATE },
        ),
      );
    // Four at once, for a ceiling one estimate wide: the advisory lock is what
    // makes exactly one win rather than four. More contenders than the brief's
    // two, because two can serialize by luck and pass a broken lock.
    const results = await Promise.all([claim(), claim(), claim(), claim()]);
    const wins = results.filter((r) => r.ok);
    expect(results.length).toBe(4);
    expect(wins.length).toBe(1);
    // Sum of open reservations must never exceed the daily ceiling.
    const open = await db
      .select()
      .from(spendingReservations)
      .where(
        and(
          eq(spendingReservations.workspaceId, ws.workspaceId),
          eq(spendingReservations.status, "reserved"),
        ),
      );
    const total = open.reduce((acc, r) => acc + Number(r.reservedUsd), 0);
    expect(total).toBeLessThanOrEqual(Number(DAILY));
  });

  it("settle is idempotent and writes one settlement row", async () => {
    const ws = await seedWs(`spend-settle-${Date.now()}`);
    const r = await withTransaction((tx) =>
      commands.reserveSpend(
        tx,
        { workspaceId: ws.workspaceId },
        { runId: null, model: "x", estimateUsd: TINY },
      ),
    );
    if (!r.ok) throw new Error("reserve should have succeeded");
    const first = await withTransaction((tx) =>
      commands.settleSpend(
        tx,
        { workspaceId: ws.workspaceId },
        { reservationId: r.reservationId, actualUsd: TINY, usage: { input: 1, output: 2 } },
      ),
    );
    const second = await withTransaction((tx) =>
      commands.settleSpend(
        tx,
        { workspaceId: ws.workspaceId },
        { reservationId: r.reservationId, actualUsd: TINY, usage: { input: 1, output: 2 } },
      ),
    );
    expect(first.wasSettled).toBe(true);
    expect(second.wasSettled).toBe(false); // no-op on already-settled
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(spendSettlements)
      .where(eq(spendSettlements.reservationId, r.reservationId));
    expect(count).toBe(1);
  });

  it("per-run ceiling blocks an oversized estimate with onExceeded action", async () => {
    const ws = await seedWs(`spend-per-run-${Date.now()}`, undefined, PER_RUN);
    const r = await withTransaction((tx) =>
      commands.reserveSpend(
        tx,
        { workspaceId: ws.workspaceId },
        { runId: null, model: "x", estimateUsd: "1.00" },
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.action).toBe("fail");
  });

  it("release frees the reservation", async () => {
    const ws = await seedWs(`spend-release-${Date.now()}`);
    const r = await withTransaction((tx) =>
      commands.reserveSpend(
        tx,
        { workspaceId: ws.workspaceId },
        { runId: null, model: "x", estimateUsd: TINY },
      ),
    );
    if (!r.ok) throw new Error("reserve should have succeeded");
    await withTransaction((tx) =>
      commands.releaseSpend(tx, { workspaceId: ws.workspaceId }, { reservationId: r.reservationId }),
    );
    const [row] = await db
      .select()
      .from(spendingReservations)
      .where(eq(spendingReservations.id, r.reservationId));
    expect(row.status).toBe("released");
  });
});
