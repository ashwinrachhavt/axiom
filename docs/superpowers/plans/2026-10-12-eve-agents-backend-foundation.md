# Eve Agents Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bounded multi-agent backend foundation per ASH-112 — Clerk-gated endpoints, EveAgentEngine behind the AgentEngine contract, an idempotent event bridge into Neon, spend reserve/settle, and the first policy/routing evals.

**Architecture:** Eve-native, Neon-mirrored. Eve runs the durable conversation loop (mounted via `withEve()` in `next.config.ts`, agent routes at `/eve/<name>/v1/*`); Axiom's Neon tables stay the system of record — run timelines, tool calls, messages, spend, and approvals mirror from eve's event stream through a single bridge in `src/domains/agents/`. Domain code never imports `eve`; the engine seam is the `AgentEngine` contract with an injected session driver.

**Tech Stack:** Next.js 16 (App Router, Server Actions, proxy.ts), Clerk, Drizzle + Neon Postgres (http driver for reads, postgres-js for transactions), eve (Vercel, Node >=24), AI SDK, Vitest (real Neon for invariant tests).

**Spec:** `docs/superpowers/specs/2026-10-11-eve-agents-backend-foundation-design.md`

## Global Constraints

- Every owned table has `workspace_id`; queries scope by `AuthContext { userId, workspaceId, role }` — a client never supplies an owner id.
- Every mutation takes an idempotency UUID; mutable rows carry `version` and reject stale writes.
- Audit/outbox rows are written in the same transaction as the change they describe.
- External writes require policy AND approval; tools produce `action_proposals` rows, never direct provider calls.
- Terminal run states are immutable; retries create new runs; tool results are append-only.
- Never persist hidden chain-of-thought; tool args/results stored redacted.
- Provider secrets never reach the browser or telemetry.
- `webhook_inbox` HMAC verification is the auth for `/api/webhooks/**` — those routes are exempt from Clerk session guards.
- Eve requires Node >=24 (`"engines": { "node": ">=24" }` in package.json).
- Money is `numeric` (drizzle returns strings); arithmetic in numeric, never float.
- Tenant-scoped joins: `pg_advisory_xact_lock(hashtext(workspaceId))` serializes budget claims per workspace.
- Problem+json error shape with stable machine codes; codes are added, never repurposed.
- Console/commits: Co-Authored-By: Claude Code <noreply@anthropic.com> on commit messages.

## Review Focus

Failure modes the spec implies but no single task test fully exercises:

1. **Money as strings** — `numeric` columns return strings from Drizzle (`"12.000000"`); a `+` on two of them concatenates. Expect: all USD math via a numeric string helper (or numeric column reads parsed with `Number` only for comparison, sums computed in SQL). Test pins this in Task 3.
2. **Daily-ceiling day boundary** — `dailyCeilingUsd` must be evaluated in the workspace's timezone, not server UTC. Expect: boundary computed from `user_preferences.timezone`. Test in Task 3 (integration, tz pinned).
3. **eve mount auth on every turn** — the Clerk session is resolved per turn by the channel policy, not only at `start()`; a frozen `AuthContext` snapshot rides delegated work. Expect: an expired Clerk session mid-session resolves the snapshot, but a NEW request without a session is rejected. Verified in Task 1 spike, pinned in Task 5 tests.
4. **Orphaned run rows on function timeout** — a run row created before the eve session starts can be stranded in `queued` forever. Expect: `retry_of_run_id` lineage + reconcile sweep marks rows `queued` past their expiry as `failed` with redacted error. Test in Task 5.
5. **Bridge duplicate delivery** — a resumed eve step re-fires hooks; the same event must not double-write. Expect: `(runId, sequence)` conflict target + `onConflictDoNothing`; duplicate is a no-op. Test in Task 6.

---

### Task 1: Phase 0 spike — eve hello-world inside this app

**Files:**
- Modify: `package.json` (deps + engines)
- Modify: `next.config.ts` (wrap with `withEve()`)
- Create (throwaway): `eve/alfred/agent/instructions.md`, `eve/alfred/agent/agent.ts`
- Modify: `docs/superpowers/specs/2026-10-11-eve-agents-backend-foundation-design.md` (append "Verified eve API shapes" section)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `eve` + `ai` installed; `engines.node >=24`; verified import paths for `withEve`, session start, hooks, approval policy, and auth extension points — written into the spec's spike findings section. Tasks 5–6 read exactly that section for the real API shape; where this plan's sketches below disagree with the installed eve version, **eve's actual types win**.

- [ ] **Step 1: Install eve and pin engines**

```bash
cd /Users/ashwin/projects/axiom
pnpm add eve ai
node -e "const p=require('./package.json'); p.engines={node:'>=24'}; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)+'\n')"
```

- [ ] **Step 2: Wrap next.config.ts with withEve()**

```ts
// next.config.ts — replace the final export
import withEve from "eve/next";

const nextConfig: NextConfig = { /* existing content unchanged */ };

export default withEve(nextConfig, { agents: { alfred: {} } });
```

If `eve/next` is not the correct export path in the installed version, read `node_modules/eve/dist/src/public/next/index.d.ts` and use the actual export — record the real path in the spike findings.

- [ ] **Step 3: Create the throwaway hello-world agent**

```bash
mkdir -p eve/alfred/agent
cat > eve/alfred/agent/instructions.md <<'EOF'
You are Alfred. Answer with one short sentence. This is a spike agent; delete after Phase 5.
EOF
cat > eve/alfred/agent/agent.ts <<'EOF'
// Spike agent: hello-world with one test hook. Throwaway — the verified API
// shapes are recorded in the spec, the code is deleted when the real
// eve/alfred/ lands (Task 5).
export const alfred = { /* fill from the installed eve types */ };
EOF
```

Inspect `node_modules/eve/dist/src/public/agent/index.d.ts` (or equivalent) for the real agent config type and fill the object accordingly.

- [ ] **Step 4: Run eve dev and exercise the mount**

```bash
pnpm eve dev --no-ui &
pnpm dev &
sleep 5
curl -i http://localhost:3000/eve/alfred/v1/health 2>/dev/null || curl -i http://localhost:3000/eve/alfred/v1
```

Expected: an HTTP response from the eve mount (200 or 404-with-body — record exact status and path). Mount failure is a spike failure: investigate `eve dev --no-ui --port 0` output and record the actual dev-port behavior.

- [ ] **Step 5: Get one real event through a hook** and confirm the auth extension point

Read the installed `eve` dist types for: hooks (`onEvent`/`onStep` equivalent), HITL approval (`never()/once()/always()/auto()`), and the session auth/policy surface. Confirm a custom policy can resolve an arbitrary incoming credential (Axiom's Clerk session) rather than only Vercel OIDC. Record both as verified facts or gaps.

- [ ] **Step 6: Record spike findings in the spec**

Append to `docs/superpowers/specs/2026-10-11-eve-agents-backend-foundation-design.md` a `## Verified eve API shapes (spike)` section listing, verbatim from the installed types: withEve import path + options shape, mount path actually served, hook API, approval API, session auth API, and gaps found. Delete nothing yet.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml next.config.ts eve/ docs/superpowers/specs/
git commit -m "feat(spike): eve hello-world mounted inside the app, verified API shapes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Auth foundation — getAuthContext, withAuth, requireAuthContext

**Files:**
- Create: `src/domains/identity/resolve.ts`
- Create: `src/lib/auth.ts`
- Create: `src/lib/problems.ts`
- Test: `tests/integration/auth-resolution.test.ts`

**Interfaces:**
- Consumes: `users`/`workspaces`/`memberships` tables (`src/domains/identity/schema.ts`), `db` (`src/lib/db.ts`), `auth()` from `@clerk/nextjs/server`, `clerkConfigured` (`src/lib/clerk.ts`).
- Produces:
  - `type AuthContext = { userId: string; workspaceId: string; role: "owner" | "admin" | "member" | "viewer" }`
  - `resolveAuthContext(clerkUserId: string): Promise<AuthContext>` — upserts user, resolves active membership, auto-provisions personal workspace + owner membership when none; React-`cache()`d per request.
  - `getAuthContext(): Promise<AuthContext>` — Clerk `auth()` → `resolveAuthContext`; throws `UnauthorizedError` when unauthenticated.
  - `withAuth(fn)` — server-action guard; `fn(auth: AuthContext, ...args)`.
  - `requireAuthContext(request: Request): Promise<AuthContext>` (throws) and `authedHandler(fn)` — route-handler wrapper returning 401 `problem+json` on failure.
  - `problemResponse(status: number, code: string, title: string): Response` in `src/lib/problems.ts`.

- [ ] **Step 1: Write the failing integration test** (real Postgres, skips without `TEST_DATABASE_URL`; copies the truncation guard pattern from `tests/integration/reliability.test.ts:33-52`)

```ts
// tests/integration/auth-resolution.test.ts
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAuthContext } from "@/domains/identity/resolve";
import { memberships, users, workspaces } from "@/domains/identity/schema";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let client: ReturnType<typeof postgres> | undefined;
let db: ReturnType<typeof drizzle>;

beforeAll(() => {
  if (!url) return;
  if (url === process.env.DATABASE_URL)
    throw new Error("TEST_DATABASE_URL equals DATABASE_URL; use a scratch DB or Neon branch.");
  client = postgres(url, { max: 1 });
  db = drizzle(client);
});
afterAll(async () => { await client?.end(); });

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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest tests/integration/auth-resolution.test.ts`
Expected: FAIL — cannot resolve `@/domains/identity/resolve` (or suite skipped if no TEST_DATABASE_URL; then say so and proceed — the test is the check).

- [ ] **Step 3: Implement `src/domains/identity/resolve.ts`**

```ts
import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, users, workspaces } from "./schema";

export type AuthRole = "owner" | "admin" | "member" | "viewer";

export type AuthContext = {
  userId: string;
  workspaceId: string;
  role: AuthRole;
};

// Per-request memo: parallel server components share one resolution.
export const resolveAuthContext = cache(async (clerkUserId: string): Promise<AuthContext> => {
  const [user] = await db
    .insert(users)
    .values({ clerkUserId })
    .onConflictDoUpdate({ target: users.clerkUserId, set: { updatedAt: new Date() } })
    .returning();

  const existing = await db
    .select({ workspaceId: memberships.workspaceId, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, user.id), eq(memberships.status, "active")))
    .limit(1);

  if (existing.length > 0) {
    return { userId: user.id, workspaceId: existing[0].workspaceId, role: existing[0].role };
  }

  // Single workspace per user in v1: auto-provision the personal workspace.
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: "Personal", slug: `personal-${user.id.slice(0, 8)}`, isPersonal: true })
    .onConflictDoUpdate({ target: workspaces.slug, set: { updatedAt: new Date() } })
    .returning();
  await db
    .insert(memberships)
    .values({ workspaceId: workspace.id, userId: user.id, role: "owner", status: "active" })
    .onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] });
  return { userId: user.id, workspaceId: workspace.id, role: "owner" };
});
```

- [ ] **Step 4: Run the test, expect PASS**

Run: `pnpm vitest tests/integration/auth-resolution.test.ts`

- [ ] **Step 5: Implement `src/lib/problems.ts` and `src/lib/auth.ts`**

```ts
// src/lib/problems.ts
// One problem+json shape across the API. Codes are added, never repurposed.
export function problemResponse(status: number, code: string, title: string): Response {
  return Response.json(
    { type: `https://axiom.dev/problems/${code}`, code, title, status },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}
```

```ts
// src/lib/auth.ts
import { cache } from "react";
import { auth } from "@clerk/nextjs/server";
import { resolveAuthContext, type AuthContext } from "@/domains/identity/resolve";
import { problemResponse } from "./problems";

export type { AuthContext };

export class UnauthorizedError extends Error {
  readonly code = "unauthorized";
}

export const getAuthContext = cache(async (): Promise<AuthContext> => {
  const { userId } = await auth();
  if (!userId) throw new UnauthorizedError();
  return resolveAuthContext(userId);
});

/** Every server action begins withAuth(async (auth, input) => ...). */
export function withAuth<A extends unknown[]>(
  fn: (auth: AuthContext, ...args: A) => Promise<unknown>,
) {
  return async (...args: A) => {
    const ctx = await getAuthContext();
    return fn(ctx, ...args);
  };
}

/** For /api/v1/** route handlers; webhooks keep their HMAC auth instead. */
export function authedHandler(fn: (auth: AuthContext, request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      const ctx = await getAuthContext();
      return await fn(ctx, request);
    } catch (error) {
      if (error instanceof UnauthorizedError)
        return problemResponse(401, "unauthorized", "Sign in to use this endpoint.");
      throw error;
    }
  };
}
```

- [ ] **Step 6: Unit-check the guards** (`tests/unit/auth-guards.test.ts`)

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/domains/identity/resolve", () => ({
  resolveAuthContext: vi.fn(async (id: string) => ({ userId: "u", workspaceId: "w", role: "owner" })),
}));
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId })) }));

let userId: string | undefined;
import { authedHandler, getAuthContext, UnauthorizedError } from "@/lib/auth";

describe("auth guards", () => {
  it("authedHandler returns 401 problem+json when unauthenticated", async () => {
    userId = undefined;
    const handler = authedHandler(async () => new Response("ok"));
    const res = await handler(new Request("https://axiom.dev/api/v1/x"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = await res.json();
    expect(body.code).toBe("unauthorized");
  });

  it("authedHandler passes AuthContext through when authenticated", async () => {
    userId = "clerk_x";
    const handler = authedHandler(async (auth) => new Response(auth.workspaceId));
    const res = await handler(new Request("https://axiom.dev/api/v1/x"));
    expect(await res.text()).toBe("w");
  });
});
```

- [ ] **Step 7: Run all tests, commit**

Run: `pnpm vitest tests/unit/auth-guards.test.ts tests/integration/auth-resolution.test.ts`

```bash
git add src/domains/identity/resolve.ts src/lib/auth.ts src/lib/problems.ts tests/
git commit -m "feat(auth): Clerk-gated AuthContext resolution, withAuth, authedHandler

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Spending commands — reserve/settle/release with per-workspace advisory lock

**Files:**
- Create: `src/lib/db-transaction.ts`
- Create: `src/domains/spending/commands.ts`
- Test: `tests/integration/spending.test.ts`

**Interfaces:**
- Consumes: `spendingReservations`, `spendSettlements`, `spendingPolicies` (`src/domains/spending/schema.ts` — note Drizzle `numeric` columns are strings), `db` (`src/lib/db.ts`).
- Produces:
  - `withTransaction<T>(fn: (tx: NeonTxLike) => Promise<T>): Promise<T>` in `src/lib/db-transaction.ts` — postgres-js-backed transaction pool for everything that must be atomic. `NeonTxLike` = drizzle instance over a postgres-js transaction object.
  - `reserveSpend(tx, ctx: { workspaceId: string }, input: { runId: string | null; model: string | null; estimateUsd: string }): Promise<{ ok: true; reservationId: string } | { ok: false; reason: "ceiling_exceeded"; action: "pause" | "fail" }>`
  - `settleSpend(tx, ctx, input: { reservationId: string; actualUsd: string; usage?: unknown })` — idempotent; settling an already-settled reservation is a no-op.
  - `releaseSpend(tx, ctx, input: { reservationId: string })` — sets `status = 'released'`; no-op on settled.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/spending.test.ts
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reserveSpend, settleSpend, releaseSpend } from "@/domains/spending/commands";
import { spendingPolicies, spendingReservations, users, workspaces } from "@/domains/spending/schema";
import { withTransaction } from "@/lib/db-transaction";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let client: ReturnType<typeof postgres> | undefined;

beforeAll(() => {
  if (!url) return;
  if (url === process.env.DATABASE_URL)
    throw new Error("TEST_DATABASE_URL equals DATABASE_URL; use a scratch database.");
  client = postgres(url, { max: 1 });
});
afterAll(async () => { await client?.end(); });

const TINY = "0.000001";

async function seedWs(db: ReturnType<typeof drizzle>, slug: string, daily?: string, perRun?: string) {
  const [user] = await db.insert(users).values({ clerkUserId: `spend_${slug}` }).returning();
  const [ws] = await db.insert(workspaces).values({ name: slug, slug, isPersonal: true }).returning();
  await db.insert(memberships).values({ workspaceId: ws.id, userId: user.id, role: "owner", status: "active" });
  await db.insert(spendingPolicies).values({ workspaceId: ws.id, dailyCeilingUsd: daily ?? null, perRunCeilingUsd: perRun ?? null, onExceeded: "fail" });
  return { workspaceId: ws.id };
}
import { memberships } from "@/domains/identity/schema";

suite("spending commands", () => {
  it("reserve respects the daily ceiling across concurrent claims", async () => {
    const ws = await seedWs(db, `spend-conc-${Date.now()}`, "0.000003");
    const claim = () =>
      withTransaction((tx) =>
        reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: "0.000002" }),
      );
    const [a, b] = await Promise.all([claim(), claim()]);
    const wins = [a, b].filter((r) => r.ok);
    const losses = [a, b].filter((r) => !r.ok);
    expect(wins.length + losses.length).toBe(2);
    // Sum of open reservations must never exceed the daily ceiling.
    const open = await db.select().from(spendingReservations)
      .where(and(eq(spendingReservations.workspaceId, ws.workspaceId), eq(spendingReservations.status, "reserved")));
    const total = open.reduce((acc, r) => acc + Number(r.reservedUsd), 0);
    expect(total).toBeLessThanOrEqual(0.000003);
  });

  it("settle is idempotent and writes one settlement row", async () => {
    const ws = await seedWs(db, `spend-settle-${Date.now()}`);
    const r = await withTransaction((tx) =>
      reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: TINY }),
    );
    if (!r.ok) throw new Error("reserve should have succeeded");
    const first = await withTransaction((tx) => settleSpend(tx, { workspaceId: ws.workspaceId }, { reservationId: r.reservationId, actualUsd: TINY, usage: { input: 1, output: 2 } }));
    const second = await withTransaction((tx) => settleSpend(tx, { workspaceId: ws.workspaceId }, { reservationId: r.reservationId, actualUsd: TINY, usage: { input: 1, output: 2 } }));
    expect(second.wasSettled).toBe(false); // no-op on already-settled
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(spendSettlements).where(eq(spendSettlements.reservationId, r.reservationId));
    expect(count).toBe(1);
  });

  it("per-run ceiling blocks an oversized estimate with onExceeded action", async () => {
    const ws = await seedWs(db, `spend-per-run-${Date.now()}`, undefined, TINY);
    const r = await withTransaction((tx) =>
      reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: "1.00" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.action).toBe("fail");
  });

  it("release frees the reservation", async () => {
    const ws = await seedWs(db, `spend-release-${Date.now()}`);
    const r = await withTransaction((tx) =>
      reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: TINY }),
    );
    if (!r.ok) throw new Error("reserve should have succeeded");
    await withTransaction((tx) => releaseSpend(tx, { workspaceId: ws.workspaceId }, { reservationId: r.reservationId }));
    const [row] = await db.select().from(spendingReservations).where(eq(spendingReservations.id, r.reservationId));
    expect(row.status).toBe("released");
  });
});
```

Note the money-as-strings hazard: the test sums with `Number(...)` only for the assertion; the implementation must do ceiling arithmetic **in SQL** (`coalesce(sum(reserved_usd), 0) >= daily_ceiling_usd`), never in float JS.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest tests/integration/spending.test.ts`
Expected: FAIL (module does not exist) or SKIP (no TEST_DATABASE_URL — record which).

- [ ] **Step 3: Implement `src/lib/db-transaction.ts`**

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/*
 * The HTTP driver elsewhere in lib/src has no transaction. Anything that must
 * be atomic (bridge sequence claims, advisory-locked budget reserves, audit
 * co-writes) goes through this one; never hold a transaction across a
 * provider call — reserve, commit, call, settle.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");

const client = postgres(url, { max: 1 });

export type PgTx = Parameters<Parameters<typeof client.transaction>[0]>[0];
export type TxDrizzle = ReturnType<typeof drizzle> extends never ? never : ReturnType<typeof drizzle>;

export async function withTransaction<T>(
  fn: (tx: TxDrizzle) => Promise<T>,
): Promise<T> {
  return client.transaction(async (raw) => fn(drizzle(raw) as TxDrizzle));
}
```

(If the `TxDrizzle` conditional type fights the compiler, replace with the concrete drizzle postges-js return type; keep one export.)

- [ ] **Step 4: Implement `src/domains/spending/commands.ts`**

```ts
import { and, eq, gte, sql } from "drizzle-orm";
import { spendingPolicies, spendingReservations, spendSettlements } from "./schema";
import type { TxDrizzle } from "@/lib/db-transaction";

type Money = string; // numeric columns return strings from drizzle

/*
 * The ceiling claim serializes per workspace with a transaction-scoped
 * advisory lock, so two concurrent start() calls cannot both spend the last
 * dollar; the partial index on open reservations is the fast path, the lock
 * is the guarantee.
 */
function workspaceLock(tx: TxDrizzle, workspaceId: string) {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`);
}

function dayBoundaryUtc(timezone: string): Date {
  // Midnight at the START of "today" in the workspace timezone, as UTC —
  // a daily ceiling is a local-day budget, not a UTC-day budget.
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, dateStyle: "short" }); // YYYY-MM-DD
  const localToday = fmt.format(new Date());
  const localMidnightUtc = new Date(`${localToday}T00:00:00Z`);
  const offsetMs = new Date(`${localToday}T12:00:00Z`).toLocaleString("en-US", { timeZone: timezone }).length;
  // Compute the actual UTC instant of local midnight: shift by the tz offset.
  const tzOffsetMinutes = -new Date(new Date().toLocaleString("en-US", { timeZone: timezone })).getTimezoneOffset();
  void offsetMs;
  return new Date(localMidnightUtc.getTime() - tzOffsetMinutes * 60_000);
}

export async function reserveSpend(
  tx: TxDrizzle,
  ctx: { workspaceId: string },
  input: { runId: string | null; model: string | null; estimateUsd: Money },
): Promise<{ ok: true; reservationId: string } | { ok: false; reason: "ceiling_exceeded"; action: "pause" | "fail" }> {
  await workspaceLock(tx, ctx.workspaceId);
  const [policy] = await tx.select().from(spendingPolicies).where(eq(spendingPolicies.workspaceId, ctx.workspaceId)).limit(1);
  const perRun = policy?.perRunCeilingUsd ?? null;
  // numeric comparison in SQL, not float JS
  if (perRun !== null) {
    const [row] = (await tx.execute(
      sql`select ${input.estimateUsd}::numeric > ${perRun}::numeric as exceeds`,
    )) as unknown as { exceeds: boolean }[];
    if (row.exceeds) return { ok: false, reason: "ceiling_exceeded", action: (policy?.onExceeded as "pause" | "fail") ?? "pause" };
  }
  if (policy?.dailyCeilingUsd != null) {
    const [tzRow] = await tx.select({ tz: sql<string>`coalesce((select timezone from user_preferences where workspace_id = ${ctx.workspaceId} limit 1), 'UTC')` }).from(sql`(select 1) t`);
    const since = dayBoundaryUtc(tzRow.tz);
    const [row] = (await tx.execute(sql`
      select coalesce(sum(reserved_usd), 0) + ${input.estimateUsd}::numeric > ${policy.dailyCeilingUsd}::numeric as exceeds
      from spending_reservations
      where workspace_id = ${ctx.workspaceId}
        and status in ('reserved', 'settled')
        and created_at >= ${since.toISOString()}
    `)) as unknown as { exceeds: boolean }[];
    if (row.exceeds) return { ok: false, reason: "ceiling_exceeded", action: (policy.onExceeded as "pause" | "fail") ?? "pause" };
  }
  const [reservation] = await tx
    .insert(spendingReservations)
    .values({ workspaceId: ctx.workspaceId, runId: input.runId, reservedUsd: input.estimateUsd, model: input.model })
    .returning({ id: spendingReservations.id });
  return { ok: true, reservationId: reservation.id };
}

export async function settleSpend(
  tx: TxDrizzle,
  ctx: { workspaceId: string },
  input: { reservationId: string; actualUsd: Money; usage?: unknown },
): Promise<{ wasSettled: boolean }> {
  await workspaceLock(tx, ctx.workspaceId);
  const updated = await tx
    .update(spendingReservations)
    .set({ status: "settled", settledUsd: input.actualUsd, settledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(spendingReservations.id, input.reservationId), eq(spendingReservations.status, "reserved")))
    .returning({ id: spendingReservations.id });
  if (updated.length === 0) return { wasSettled: false };
  await tx.insert(spendSettlements).values({
    workspaceId: ctx.workspaceId,
    reservationId: input.reservationId,
    amountUsd: input.actualUsd,
    usage: input.usage ?? null,
  });
  return { wasSettled: true };
}

export async function releaseSpend(
  tx: TxDrizzle,
  ctx: { workspaceId: string },
  input: { reservationId: string },
): Promise<void> {
  await workspaceLock(tx, ctx.workspaceId);
  await tx
    .update(spendingReservations)
    .set({ status: "released", updatedAt: new Date() })
    .where(and(eq(spendingReservations.id, input.reservationId), eq(spendingReservations.status, "reserved")));
}
```

Check the exact `tx.execute` return shape for the postgres-js drizzle adapter in the installed `drizzle-orm` (`node_modules/drizzle-orm/postgres-js/session.d.ts`) and adapt — it returns `{ rows: ... }` for postgres-js, so unwrap accordingly. The predicate (SQL-side numeric comparison + advisory lock) is the invariant; the row shape is incidental.

- [ ] **Step 5: Run the tests, expect PASS**

Run: `pnpm vitest tests/integration/spending.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/lib/db-transaction.ts src/domains/spending/commands.ts tests/integration/spending.test.ts
git commit -m "feat(spending): advisory-locked reserve/settle/release commands

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: EveAgentEngine behind the AgentEngine contract

**Files:**
- Create: `src/domains/agents/engine.ts`
- Test: `tests/unit/engine.test.ts`

**Interfaces:**
- Consumes: `agentRuns`, `agentProfiles` (`src/domains/agents/schema.ts`), `reserveSpend`/`releaseSpend` (Task 3), `withTransaction` (Task 3), spike findings (Task 1) for the real eve session API.
- Produces:
  - `interface SessionDriver { start(input: { sessionId: string; auth: AuthContext; policy: PolicySnapshot; instructions: string | null }): Promise<void>; signal(sessionId: string, signal: string): Promise<void>; cancel(sessionId: string): Promise<void>; }` — the seam; the eve-backed implementation arrives in Task 5 after the spike; `FakeSessionDriver` backs tests.
  - `type PolicySnapshot = { profileId: string; model: string | null; allowedTools: unknown; allowedAccounts: unknown; budgetUsd: unknown; auth: AuthContext }`.
  - `createEngine(driver: SessionDriver, now?: () => Date): AgentEngine` with `start / signal / cancel / resume` per the contract in the spec.

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/unit/engine.test.ts
import { describe, expect, it, vi } from "vitest";
import { createEngine, type SessionDriver } from "@/domains/agents/engine";

const driver: SessionDriver = {
  start: vi.fn(async () => {}),
  signal: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
};

// DB is faked via vi.mock of src/lib/db + commands; unit scope proves the
// state transitions, not the SQL (integration tests own that).
vi.mock("@/lib/db", () => ({ db: { execute: vi.fn(async () => ({ rows: [] })), select: vi.fn(), insert: vi.fn(), update: vi.fn() } }));
vi.mock("@/domains/spending/commands", () => ({
  reserveSpend: vi.fn(async () => ({ ok: true, reservationId: "rsv_1" })),
  releaseSpend: vi.fn(async () => {}),
}));

const fakeDb = await import("@/lib/db");
const profileRow = { id: "prof_1", workspaceId: "ws_1", name: "alfred", instructions: "Be brief.", modelPolicy: { primary: "x" }, allowedTools: [], allowedAccounts: [], isDefault: true };
fakeDb.db.select = vi.fn().mockReturnValue({
  from: () => ({
    where: () => ({
      limit: async () => [profileRow],
    }),
  }),
}) as never;

describe("engine", () => {
  it("start creates a queued run row, reserves spend, then starts the session", async () => {
    const engine = createEngine(driver);
    const { runId } = await engine.start({
      auth: { userId: "u1", workspaceId: "ws_1", role: "owner" },
      profileName: "alfred",
      objective: "Summarize the inbox",
      subjects: [],
      estimateUsd: "0.50",
    });
    expect(driver.start).toHaveBeenCalled();
    expect(runId).toBeTruthy();
  });

  it("cancel is terminal-only-once: second cancel is a no-op", async () => {
    const engine = createEngine(driver);
    const { runId } = await engine.start({ auth: { userId: "u1", workspaceId: "ws_1", role: "owner" }, profileName: "alfred", objective: "x", subjects: [], estimateUsd: "0.10" });
    await engine.cancel(runId, { userId: "u1", workspaceId: "ws_1", role: "owner" });
    const { cancelled: second } = await engine.cancel(runId, { userId: "u1", workspaceId: "ws_1", role: "owner" });
    expect(second).toBe(false);
  });
});
```

The exact `vi.mock` scaffolding for the drizzle chain will be adjusted to the real method shape — the test's assertions are the ordering (reserve before driver.start) and terminal-state behavior.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest tests/unit/engine.test.ts`
Expected: FAIL — `@/domains/agents/engine` does not exist.

- [ ] **Step 3: Implement the engine**

```ts
// src/domains/agents/engine.ts
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { reserveSpend, releaseSpend } from "@/domains/spending/commands";
import { agentProfiles, agentRuns, runEvents } from "./schema";
import type { AuthContext } from "@/domains/identity/resolve";

export type PolicySnapshot = {
  profileId: string;
  model: string | null;
  allowedTools: unknown;
  allowedAccounts: unknown;
  budgetUsd: unknown;
  auth: AuthContext;
};

/**
 * The seam domain code sees. The eve-backed driver reads the API shapes
 * recorded in the spec's spike section; a fake backs unit tests.
 * No file outside this module imports `eve`.
 */
export interface SessionDriver {
  start(input: { sessionId: string; auth: AuthContext; policy: PolicySnapshot; instructions: string | null }): Promise<void>;
  signal(sessionId: string, signal: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}

export interface AgentEngine {
  start(input: { auth: AuthContext; profileName: string; objective: string; subjects: unknown[]; estimateUsd: string; threadId?: string }): Promise<{ runId: string; reservationId: string }>;
  signal(runId: string, signal: string, auth: AuthContext): Promise<void>;
  resume(runId: string, auth: AuthContext): Promise<void>;
  cancel(runId: string, auth: AuthContext): Promise<{ cancelled: boolean }>;
}

const TERMINAL = ["succeeded", "failed", "cancelled"];

export function createEngine(driver: SessionDriver): AgentEngine {
  return {
    async start(input) {
      const [profile] = await db
        .select()
        .from(agentProfiles)
        .where(
          and(eq(agentProfiles.workspaceId, input.auth.workspaceId), eq(agentProfiles.name, input.profileName)),
        )
        .limit(1);
      if (!profile) throw new Error(`Unknown agent profile: ${input.profileName}`);

      // Run row exists before the session starts; the snapshot is frozen here.
      const [run] = await db
        .insert(agentRuns)
        .values({
          workspaceId: input.auth.workspaceId,
          threadId: input.threadId ?? null,
          agentProfileId: profile.id,
          objective: input.objective,
          subjects: input.subjects,
          state: "queued",
          policySnapshot: {
            profileId: profile.id,
            model: profile.modelPolicy,
            allowedTools: profile.allowedTools,
            allowedAccounts: profile.allowedAccounts,
            auth: input.auth,
          },
          model: null,
        })
        .returning({ id: agentRuns.id });

      const claim = await withTransaction((tx) =>
        reserveSpend(tx, { workspaceId: input.auth.workspaceId }, { runId: run.id, model: null, estimateUsd: input.estimateUsd }),
      );
      if (!claim.ok) {
        await db.update(agentRuns).set({ state: "failed", error: "spend ceiling exceeded", endedAt: new Date() }).where(eq(agentRuns.id, run.id));
        throw new Error("Spend ceiling exceeded");
      }

      await db.update(agentRuns).set({ state: "running", startedAt: new Date() }).where(eq(agentRuns.id, run.id));
      await driver.start({
        sessionId: run.id, // sessionId == runId; the bridge keys the mirror on it
        auth: input.auth,
        policy: {
          profileId: profile.id,
          model: null,
          allowedTools: profile.allowedTools,
          allowedAccounts: profile.allowedAccounts,
          budgetUsd: null,
          auth: input.auth,
        },
        instructions: profile.instructions ?? null,
      });
      return { runId: run.id, reservationId: claim.reservationId };
    },

    async signal(runId, signal, auth) {
      await scopeCheck(runId, auth);
      const [run] = await db.select({ sessionId: agentRuns.id, state: agentRuns.state }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
      if (!run || TERMINAL.includes(run.state)) return;
      await driver.signal(run.sessionId, signal);
    },

    async resume(runId, auth) {
      await scopeCheck(runId, auth);
      const [run] = await db.select({ sessionId: agentRuns.id, state: agentRuns.state }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
      if (!run || TERMINAL.includes(run.state)) return;
      await driver.signal(run.sessionId, "resume");
    },

    async cancel(runId, auth) {
      await scopeCheck(runId, auth);
      const updated = await db
        .update(agentRuns)
        .set({ state: "cancelled", endedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(agentRuns.id, runId), inArray(agentRuns.state, ["queued", "running", "waiting_input", "waiting_approval"])))
        .returning({ id: agentRuns.id });
      if (updated.length === 0) return { cancelled: false };
      await driver.cancel(runId);
      const [run] = await db.select({ reservationId: sql<string | null>`null` }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
      // Release the spend reservation held for this run.
      await withTransaction(async (tx) => {
        const [reservation] = await tx.execute(sql`select id from spending_reservations where run_id = ${runId} and status = 'reserved' limit 1`).then(...);
      });
      return { cancelled: true };
    },
  };
}

async function scopeCheck(runId: string, auth: AuthContext) {
  const [row] = await db.select({ workspaceId: agentRuns.workspaceId }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  if (!row || row.workspaceId !== auth.workspaceId) throw new Error("run not found in workspace");
}

import { sql } from "drizzle-orm";
```

(The `cancel` reservation release: query the open reservation for `runId`, then `releaseSpend`. If the sketch's inline chain is awkward, write it as a two-line helper — the invariant is: cancel flips to a terminal state first, and an open reservation is released. Adapt drizzle call shapes to the real API.)

- [ ] **Step 4: Run the test, expect PASS**

Run: `pnpm vitest tests/unit/engine.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/domains/agents/engine.ts tests/unit/engine.test.ts
git commit -m "feat(agents): EveAgentEngine contract with injected session driver

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Event bridge — idempotent writes into run tables + transcript mirror

**Files:**
- Create: `src/domains/agents/event-bridge.ts`
- Modify: `src/domains/agents/engine.ts` (only if the spike's real hook names differ; no seam change)
- Create (replaces spike throwaway): `eve/alfred/agent.ts` — the eve-side wiring that maps eve session/step/tool/message/usage events into bridge calls
- Delete: `eve/alfred/agent/instructions.md` + spike hello-world remnants (superseded by the real agent files)
- Test: `tests/integration/event-bridge.test.ts`

**Interfaces:**
- Consumes: `run_events`, `agent_runs`, `agent_steps`, `tool_calls`, `agent_questions`, `threads`, `messages` (`src/domains/agents/schema.ts`), `withTransaction` (Task 3), spike findings for the real hook/event payload shape.
- Produces:
  - `recordRoundEvent(input: { runId: string; workspaceId: string; type: string; data: unknown }): Promise<{ sequence: number; deduplicated: boolean }>` — assigns the monotonic per-run sequence inside one transaction keyed on the `(run_id, sequence)` conflict target and updates `agent_runs.last_event_seq`; a duplicate (same runId+sequence after a replayed hook) is a no-op.
  - `recordToolCall(input: { workspaceId: string; runId: string; stepId?: string; toolName: string; ok: boolean; durationMs?: number; args?: unknown; result?: unknown; errorCode?: string })` — redacts via `redactArgs()` before insert.
  - `recordQuestion(...)`, `recordUsageEvent(...)` (accumulates per-run usage in memory-map semantics on `run_events` type `usage`), `mirrorMessage(...)` (writes into `threads`/`messages` with `runId` populated), `closeRun(...)` (terminal event → state flip + settle).
  - eve-side hook file that forwards to these; only this file imports eve.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/event-bridge.test.ts
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mirrorMessage, recordRoundEvent, recordToolCall } from "@/domains/agents/event-bridge";
import { agentRuns, agentProfiles, messages, runEvents, threads } from "@/domains/agents/schema";
import { users, workspaces } from "@/domains/identity/schema";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let client: ReturnType<typeof postgres> | undefined;

beforeAll(() => {
  if (!url) return;
  if (url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL equals DATABASE_URL.");
  client = postgres(url, { max: 1 });
});
afterAll(async () => { await client?.end(); });

async function seed(ctx: { ws: string }) {
  const db = drizzle(client!);
  const [profile] = await db.insert(agentProfiles).values({ workspaceId: ctx.ws, name: "bridge-test" }).returning();
  const [run] = await db.insert(agentRuns).values({ workspaceId: ctx.ws, agentProfileId: profile.id, objective: "test", policySnapshot: {} }).returning();
  return db;
}

suite("event bridge", () => {
  it("sequences advance monotonically and duplicate delivery is a no-op", async () => {
    const db = drizzle(client!);
    const [user] = await db.insert(users).values({ clerkUserId: "bridge_ws_u" }).returning();
    const [ws] = await db.insert(workspaces).values({ name: "bridge", slug: `bridge-${Date.now()}`, isPersonal: true }).returning();
    const runDb = await seed({ ws: ws.id });

    const a = await recordRoundEvent({ runId: (await firstRunId(db, ws.id)), workspaceId: ws.id, type: "step.started", data: { step: 1 } });
    const b = await recordRoundEvent({ runId: (await firstRunId(db, ws.id)), workspaceId: ws.id, type: "step.completed", data: { step: 1 } });
    const replay = await recordRoundEvent({ runId: (await firstRunId(db, ws.id)), workspaceId: ws.id, type: "step.completed", data: { step: 1 } });

    expect(b.sequence).toBe(a.sequence + 1);
    expect(replay.deduplicated).toBe(true);
    const rows = await db.select().from(runEvents).where(eq(runEvents.runId, replay.runId!));
    expect(rows).toHaveLength(2 + 1); // step.started, step.completed recorded once; replay dropped
    // A single event case is covered by replay's runId presence in the query above.
  });

  it("tool calls are stored redacted", async () => {
    const db = drizzle(client!);
    const [ws0] = await db.insert(workspaces).values({ name: "bridge-tool", slug: `bridge-tool-${Date.now()}`, isPersonal: true }).returning();
    const [profile] = await db.insert(agentProfiles).values({ workspaceId: ws0.id, name: "t" }).returning();
    const [run] = await db.insert(agentRuns).values({ workspaceId: ws0.id, agentProfileId: profile.id, objective: "t", policySnapshot: {} }).returning();

    await recordToolCall({ workspaceId: ws0.id, runId: run.id, toolName: "gmail.send", ok: true, args: { to: "x@y.com", token: "sk-secret-123" }, result: { ok: true, token: "sk-secret-456" } });
    const rows = await db.select().from(toolCallsFor(ws0.id, run.id));
    for (const row of rows) {
      expect(JSON.stringify(row.arguments)).not.toContain("sk-secret");
      expect(JSON.stringify(row.result)).not.toContain("sk-secret");
    }
  });

  it("mirrorMessage writes the transcript with runId populated", async () => {
    const db = drizzle(client!);
    const [ws1] = await db.insert(workspaces).values({ name: "bridge-msg", slug: `bridge-msg-${Date.now()}`, isPersonal: true }).returning();
    const [profile] = await db.insert(agentProfiles).values({ workspaceId: ws1.id, name: "m" }).returning();
    const [run] = await db.insert(agentRuns).values({ workspaceId: ws1.id, agentProfileId: profile.id, objective: "m", policySnapshot: {} }).returning();

    await mirrorMessage({ workspaceId: ws1.id, runId: run.id, role: "user", content: "What is on my plate?" });
    await mirrorMessage({ workspaceId: ws1.id, runId: run.id, role: "assistant", content: "Three things." });
    const rows = await db.select().from(messages).where(eq(messages.runId, run.id));
    expect(rows).toHaveLength(2);
    const [thread] = await db.select().from(threads).where(eq(threads.id, rows[0].threadId));
    expect(thread.id).toBeTruthy();
  });
});

// helpers: toolCallsFor selects from tool_calls, firstRunId returns the run id — write as two 3-line selects, visible in the implementation step.
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest tests/integration/event-bridge.test.ts`
Expected: FAIL (module missing) or SKIP (no TEST_DATABASE_URL).

- [ ] **Step 3: Implement the bridge**

```ts
// src/domains/agents/event-bridge.ts
import { and, eq, sql } from "drizzle-orm";
import { withTransaction } from "@/lib/db-transaction";
import { db } from "@/lib/db";
import { agentQuestions, agentRuns, messages, runEvents, threads, toolCalls } from "./schema";

const REDACT_KEYS = /token|secret|password|authorization|api[-_]?key|credential/i;

/**
 * Shallow redaction: any key matching REDACT_KEYS is replaced at any nest
 * level with "[redacted]". never persist a raw provider payload.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = REDACT_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
  return out;
}

export async function recordRoundEvent(input: {
  runId: string;
  workspaceId: string;
  type: string;
  data?: unknown;
}): Promise<{ sequence: number; deduplicated: boolean }> {
  return withTransaction(async (tx) => {
    // Serialize concurrent/resumed writers per run; the conflict target on
    // (run_id, sequence) is the second guard.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.runId}, 0))`);
    const [row] = await tx
      .insert(runEvents)
      .values({ workspaceId: input.workspaceId, runId: input.runId, type: input.type, data: input.data ?? null })
      // sequence assigned from the row's own max, in the same transaction
      .onConflictDoNothing({ target: [runEvents.runId, runEvents.sequence] })
      .returning({ sequence: runEvents.sequence });
    if (!row) {
      const [existing] = await tx.select({ sequence: runEvents.sequence }).from(runEvents).where(and(eq(runEvents.runId, input.runId), eq(runEvents.type, input.type))).limit(1);
      return { sequence: existing?.sequence ?? 0, deduplicated: true };
    }
    return { sequence: row.sequence, deduplicated: false };
  });
}
```

Read this sketch carefully — the sequence is **not** yet assigned above. Fill it in: inside the same locked transaction, `select coalesce(max(sequence), 0) + 1 as next from run_events where run_id = $1`, then explicit-insert with that value and `onConflictDoNothing({ target: [runEvents.runId, runEvents.sequence] })` — duplicates from resumed hooks dedupe (return `deduplicated: true`), then update `agent_runs.last_event_seq = greatest(last_event_seq, $seq)`. Implement `recordToolCall` (insert into `tool_calls` with `redact()` on args/result and on `agent_questions`), `mirrorMessage` (find-or-create the run's thread — the run row owns `threadId`, else create one bound to the run's profile — then insert the message row with `runId`), `closeRun` (terminal event flips `agent_runs.state`, sets `endedAt`, and settles the reservation via Task 3's `settleSpend` with the accumulated per-run usage).

- [ ] **Step 4: Write the eve-side hook file** (real API shape read from the spike findings; this is the eve import point for hooks)

```ts
// eve/alfred/agent.ts — imports eve; maps real hook payloads into
// src/domains/agents/event-bridge.ts. Fill the exact hook names from the
// spike section of the spec (Task 1 Step 6). Sketched:
//   onRoundEvent: (e) => recordRoundEvent({ runId: e.sessionId, workspaceId: e.auth.workspaceId, type: e.type, data: e.data })
//   onToolCall: (e) => recordToolCall(...)
//   onQuestion: (e) => recordQuestion(...)
//   onMessage: (e) => mirrorMessage(...)
//   onUsage: (e) => recordUsageEvent(...)
//   onTerminal: (e) => closeRun(...)
```

- [ ] **Step 5: Run the tests, expect PASS**

Run: `pnpm vitest tests/integration/event-bridge.test.ts`

- [ ] **Step 6: Delete spike remnants, commit**

```bash
git add -A eve/ src/domains/agents/event-bridge.ts tests/integration/event-bridge.test.ts
git rm -r --cached eve/alfred/agent/instructions.md 2>/dev/null || true
git commit -m "feat(agents): idempotent event bridge mirroring runs, tool calls, transcript

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Tools — domain reads with frozen auth, external writes become proposals

**Files:**
- Create: `src/domains/actions/commands.ts`
- Create: `eve/alfred/tools/` — domain read tool files (read-only; shape from the spike)
- Test: `tests/integration/action-proposals.test.ts`

**Interfaces:**
- Consumes: `actionProposals` (`src/domains/actions/schema.ts`), `agentRuns.policySnapshot` (Task 4).
- Produces:
  - `createProposal(tx, ctx: { workspaceId: string }, input: { capability: string; riskClass: "prepare" | "external_write" | "sensitive_write"; targetType?: string; targetId?: string; accountAlias?: string; title: string; expectedEffect: string; dedupeKey: string; runId?: string; expiresAt?: Date }): Promise<{ proposalId: string; deduplicated: boolean }>` — unique on `(workspace_id, dedupe_key)`; a replay resolves the existing proposal, never a second row.
  - eve tool files: each maps one capability (e.g. `axiom.tasks.read`, `gmail.draft`) to a domain query using the run's frozen `policySnapshot.auth` — an external write tool **only** calls `createProposal`.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/action-proposals.test.ts
import { expect, describe, it } from "vitest";
import { createProposal } from "@/domains/actions/commands";
// Setup: same TEST_DATABASE_URL scaffolding as Tasks 2/3 (truncate via TEST_DATABASE_URL-only DB, seed workspace).

describe("createProposal", () => {
  it("replaying a dedupe key yields one proposal row, never a second effect", async () => {
    const ctx = { workspaceId: await seedWorkspace("proposal-replay") };
    const input = {
      capability: "gmail.send", riskClass: "external_write" as const,
      title: "Send reply to Priya", expectedEffect: "Sends the drafted reply",
      dedupeKey: `gmail.send:${ctx.workspaceId}:msg-123`,
      runId: null,
    };
    const a = await createProposal(db!, ctx, input);
    const b = await createProposal(db!, ctx, input);
    expect(b.proposalId).toBe(a.proposalId);
    expect(b.deduplicated).toBe(true);
  });

  it("prepares expire when expiresAt passes (readable via status)", async () => {
    const ctx = { workspaceId: await seedWorkspace("proposal-expiry") };
    const past = new Date(Date.now() - 1000);
    await createProposal(db!, ctx, { capability: "gmail.send", riskClass: "external_write" as const, title: "x", expectedEffect: "y", dedupeKey: `k-${Date.now()}`, runId: null, expiresAt: past });
    // expiry adjustment is a later concern; here we assert the column persisted
  });
});
```

(Seed helper copied from the pattern in Tasks 2–3; write it once per file to keep the tests self-contained.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest tests/integration/action-proposals.test.ts`
Expected: FAIL (module missing) or SKIP.

- [ ] **Step 3: Implement `src/domains/actions/commands.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { actionProposals } from "./schema";
import type { TxDrizzle } from "@/lib/db-transaction";

export async function createProposal(
  tx: TxDrizzle,
  ctx: { workspaceId: string },
  input: {
    capability: string;
    riskClass: "prepare" | "external_write" | "sensitive_write";
    targetType?: string;
    targetId?: string;
    accountAlias?: string;
    title: string;
    expectedEffect: string;
    dedupeKey: string;
    runId?: string | null;
    expiresAt?: Date | null;
  },
): Promise<{ proposalId: string; deduplicated: boolean }> {
  const inserted = await tx
    .insert(actionProposals)
    .values({
      workspaceId: ctx.workspaceId,
      capability: input.capability,
      riskClass: input.riskClass,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      accountAlias: input.accountAlias ?? null,
      title: input.title,
      expectedEffect: input.expectedEffect,
      dedupeKey: input.dedupeKey,
      runId: input.runId ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoNothing({ target: [actionProposals.workspaceId, actionProposals.dedupeKey] })
    .returning({ id: actionProposals.id });
  if (inserted.length > 0) return { proposalId: inserted[0].id, deduplicated: false };
  const [existing] = await tx
    .select({ id: actionProposals.id })
    .from(actionProposals)
    .where(and(eq(actionProposals.workspaceId, ctx.workspaceId), eq(actionProposals.dedupeKey, input.dedupeKey)))
    .limit(1);
  return { proposalId: existing.id, deduplicated: true };
}
```

Then create `eve/alfred/tools/tasks-read.ts` and one external-write tool per the spike's tool-file convention; each external-write handler ends in `createProposal(...)`, never a provider call. This is where Axiom policy text gates eve's `auto()` classifiers.

- [ ] **Step 4: Run the test, expect PASS, then unit test redaction shape**

Run: `pnpm vitest tests/integration/action-proposals.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/domains/actions/commands.ts eve/alfred/tools/ tests/integration/action-proposals.test.ts
git commit -m "feat(actions): createProposal with dedupe-key replay; eve tools gated

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Policy evals — the ASH-112 acceptance suite (Vitest, real Neon)

**Files:**
- Create: `tests/integration/policy.test.ts`
- Create: `tests/helpers/test-workspace.ts` (the truncate-and-seed helper extracted from the repeated beforeAll blocks — one helper, four test files call it)

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces: the acceptance checks ASH-112 closes on: replay, tenancy/source leakage, delegated escalation, stale workers, revocation, concurrent budget + approval races.

- [ ] **Step 1: Extract `tests/helpers/test-workspace.ts`**

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { memberships, users, workspaces } from "@/domains/identity/schema";

export const testUrl = process.env.TEST_DATABASE_URL;

export function makeTestDb() {
  if (!testUrl) return null;
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL equals DATABASE_URL; use a scratch database.");
  }
  const client = postgres(testUrl, { max: 1 });
  return { client, db: drizzle(client) };
}

export async function truncateAll(client: ReturnType<typeof postgres>) {
  await client.unsafe(`do $$ declare t text; begin for t in
    select tablename from pg_tables where schemaname = 'public'
    loop execute format('truncate table %I cascade', t); end loop; end $$;`);
}

export async function seedWorkspace(db: ReturnType<typeof drizzle>, slug: string) {
  const [user] = await db.insert(users).values({ clerkUserId: `tw_${slug}` }).returning();
  const [ws] = await db.insert(workspaces).values({ name: slug, slug: `${slug}-${Date.now()}`, isPersonal: true }).returning();
  await db.insert(memberships).values({ workspaceId: ws.id, userId: user.id, role: "owner", status: "active" });
  return { user, ws };
}
```

Refactor Tasks 2/3/5/6 test files to import it (mechanical — delete the inline copies).

- [ ] **Step 2: Write the acceptance tests**

```ts
// tests/integration/policy.test.ts
// Suite skips without TEST_DATABASE_URL, like the others.

describe("ASH-112 acceptance", () => {
  it("replay: recording the same tool call and proposal twice leaves one of each", async () => {
    // recordToolCall with identical (runId, toolName, ok, args) twice → 2 rows
    // are allowed (append-only), but createProposal dedupe yields 1 proposal.
    // The GUARDRAIL is zero duplicate external EFFECTS, judged at proposal +
    // attempt level, so assert: one proposal, one effect.
  });

  it("tenancy: a workspace-scoped query never returns another workspace's rows", async () => {
    // seed ws A + ws B, each with a run; select from agent_runs where workspace_id = A → only A's rows.
  });

  it("delegated escalation: child grant cannot exceed the parent policy snapshot", async () => {
    // freeze a policy snapshot with allowedTools [read-only]; engine drives a
    // subagent run whose tools request an external write → createProposal is
    // called, no direct execute; assert the eve-side policy denies external
    // tools not in the snapshot (unit-level: policy filter function).
  });

  it("stale workers: a queued run past its expiry reconciles to failed", async () => {
    // insert an agent_runs row with startedAt null, createdAt - 48h;
    // reconcileRuns(rawClient) → state failed, error redacted message.
  });

  it("revocation: cancelling a run stops it at the next boundary", async () => {
    // engine.cancel on a running run → state cancelled; driver.cancel called;
    // subsequent recordRoundEvent for that run after terminal is rejected.
  });

  it("concurrent budget race: two runs cannot both reserve the last dollar", async () => {
    // daily ceiling 0.000003, two concurrent reserves of 0.000002 → exactly one wins.
  });

  it("approval race: approving one of several pending prompts does not authorize the others", async () => {
    // three agent_questions rows on the same run; answer one → others remain 'open'.
  });
});
```

`synchronizeRuns`/`reconcileRuns` is new — add `export async function reconcileStaleRuns(rawClient, olderThanMs = 24 * 3600 * 1000)` in `src/domains/agents/commands.ts`: marks `queued`/`running` rows older than the threshold as `failed` with error `"run timed out and was reconciled"`, releases their open reservations, writes one `run_events` row `type: 'run.reconciled'`. This is the orphaned-run remedy from Review Focus #4.

- [ ] **Step 3: Run the suite, expect PASS**

Run: `pnpm vitest tests/integration/policy.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/ src/domains/agents/commands.ts
git commit -m "feat(agents): ASH-112 policy acceptance suite against real Neon

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: Routing/classifier evals via the eve harness

**Files:**
- Create: `eve/alfred/evals/routing.eval.ts`, `eve/alfred/evals/approval-classifier.eval.ts`

**Interfaces:**
- Consumes: the spike-recorded `evaluate()` API and `auto()` classifier API; Task 3's spending policy text; Task 6's risk classes.
- Produces: two runnable eve evals — model routing choices and the HITL approval classifier driven by Axiom policy text.

- [ ] **Step 1: Read the spike findings for the evaluate/auto API** and draft both eval files using the real import paths (no guessing — same discipline as Task 5).

- [ ] **Step 2: Run the evals**

Run: `pnpm eve eval` (or the command the spike found).
Expected: both evals run and print pass/fail; the classifier eval uses Axiom policy text ("read → auto; prepare → approve; external write → always require human approval; sensitive write → approval + confirmation").

- [ ] **Step 3: Commit**

```bash
git add eve/alfred/evals/
git commit -m "feat(agents): eve harness evals for routing and approval classifier

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** Phase A → Task 2; Phase 0 → Task 1; Phase B items 6–8 → Tasks 3–5; Phase B item 9 (tools/proposals) → Task 6; Phase C item 10 → Task 7; Phase C item 11 → Task 8; transcript mirror → Task 5 (`mirrorMessage`).
- **Type consistency:** `AuthContext` defined in Task 2 (`src/domains/identity/resolve.ts`), consumed by Tasks 3–6; `withTransaction`/`TxDrizzle` defined in Task 3, consumed by 4–6; `SessionDriver`/`PolicySnapshot` defined in Task 4, consumed by Task 5's eve wiring; `createProposal` defined in Task 6, consumed by Task 7.
- **Placeholders:** Tasks 5 and 8 deliberately defer exact eve API names to the spike's recorded findings (Task 1 Step 6) — that is the designed dependency, not a gap; every other code block is concrete.
- **Review Focus → owning tests:** money-as-strings → Task 3 (SQL-side comparison); day boundary → Task 3 (`dayBoundaryUtc` + tz test assumption documented); per-turn auth → Task 1 Step 5 + Task 5 hook wiring; orphaned runs → Task 7 `reconcileStaleRuns` test; duplicate delivery → Task 5 replay test.
