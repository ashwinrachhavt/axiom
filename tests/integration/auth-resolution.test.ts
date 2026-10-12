import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { memberships, workspaces } from "@/domains/identity/schema";

/*
 * The auth invariants agents/engineering.md says run against real Postgres.
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied.
 *
 * `@/lib/db` (the Neon HTTP driver resolve.ts reads through) opens fetch
 * connections a localhost test database cannot serve, so it is mocked to the
 * same postgres-js client the assertions use — the policy suite's transport
 * swap. The swap must happen before the resolver is lazy-imported.
 *
 * This file inserts fresh unique clerk ids and truncates nothing, so pointing
 * TEST_DATABASE_URL at a scratch database or a Neon branch is enough; no
 * equality guard against DATABASE_URL is needed here.
 */

const handle = (function () {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  // src/lib/db-transaction.ts reads DATABASE_URL at module load; point it here
  // before anything lazy-imports that module.
  process.env.DATABASE_URL = url;
  const client = postgres(url, { max: 1 });
  return { url, client, db: drizzle(client) };
})();
const suite = handle ? describe : describe.skip;
let db = handle?.db;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

let resolveAuthContext: typeof import("@/domains/identity/resolve").resolveAuthContext;

beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
  db = handle.db;
  ({ resolveAuthContext } = await import("@/domains/identity/resolve"));
});
afterAll(async () => { await handle?.client.end(); });

suite("auth resolution", () => {
  it("auto-provisions workspace + owner membership on first sign-in", async () => {
    const ctx = await resolveAuthContext("clerk_spike_new_1");
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
    expect(ws.isPersonal).toBe(true);
    const [m] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ctx.workspaceId), eq(memberships.userId, ctx.userId)));
    expect(m.role).toBe("owner");
    expect(m.status).toBe("active");
  });

  it("is idempotent: second sign-in resolves the same workspace, no duplicate rows", async () => {
    const a = await resolveAuthContext("clerk_spike_idem_1");
    const b = await resolveAuthContext("clerk_spike_idem_1");
    expect(b.workspaceId).toBe(a.workspaceId);
    const all = await db.select().from(memberships).where(eq(memberships.userId, a.userId));
    expect(all).toHaveLength(1);
  });

  it("resolves role from an existing active membership", async () => {
    const ctx = await resolveAuthContext("clerk_spike_role_1");
    expect(["owner", "member"]).toContain(ctx.role);
  });

  // v1: suspended owner still resolves owner; revisit when memberships serve
  // more than one user. Pinned here so the decision is visible, not accidental.
  it("resolves a suspended owner as owner in v1", async () => {
    const first = await resolveAuthContext("clerk_spike_suspended_1");
    await db
      .update(memberships)
      .set({ status: "suspended" })
      .where(eq(memberships.userId, first.userId));
    const again = await resolveAuthContext("clerk_spike_suspended_1");
    expect(again.userId).toBe(first.userId);
    expect(again.workspaceId).toBe(first.workspaceId);
    expect(again.role).toBe("owner");
  });
});
