import { and, eq, sql } from "drizzle-orm";
import type { TxDrizzle } from "../../lib/db-transaction";
import { spendingPolicies, spendingReservations, spendSettlements } from "./schema";

/*
 * Reserve, settle, release — the three moves that make a budget ceiling hold.
 * The ceiling is checked as `numeric` inside SQL: JS numbers are floats, and a
 * float compared against money is a rounding bug wearing a currency sign.
 *
 * A workspace's claim is serialized with a transaction-scoped advisory lock
 * (`pg_advisory_xact_lock`, released when the transaction ends). The partial
 * index on open reservations is the fast path; the lock is the guarantee that
 * two concurrent runs cannot both spend the last dollar.
 */

/** numeric columns come back from drizzle as strings; keep them strings. */
type Money = string;

type ExceededAction = "pause" | "fail";

type ReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: "ceiling_exceeded"; action: ExceededAction };

/*
 * drizzle-orm 0.45's postgres-js `execute` resolves to a plain array of rows,
 * not a `{ rows }` envelope. Typing that once here keeps every caller's read
 * from being a cast.
 */
function firstRow<TRow extends Record<string, unknown>>(
  rows: unknown[],
): TRow | undefined {
  return rows[0] as TRow | undefined;
}

function workspaceLock(tx: TxDrizzle, workspaceId: string) {
  // hashtextextended maps the workspace uuid onto the lock's bigint key space;
  // the 0 seed is arbitrary but fixed, which is all a lock key needs.
  return tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`);
}

function exceeded(policy: { onExceeded: string } | undefined): ReserveResult {
  return {
    ok: false,
    reason: "ceiling_exceeded",
    action: (policy?.onExceeded as ExceededAction | undefined) ?? "pause",
  };
}

export async function reserveSpend(
  tx: TxDrizzle,
  ctx: { workspaceId: string },
  input: { runId: string | null; model: string | null; estimateUsd: Money },
): Promise<ReserveResult> {
  await workspaceLock(tx, ctx.workspaceId);

  const [policy] = await tx
    .select()
    .from(spendingPolicies)
    .where(eq(spendingPolicies.workspaceId, ctx.workspaceId))
    .limit(1);

  const perRun = policy?.perRunCeilingUsd ?? null;
  if (perRun !== null) {
    const row = firstRow<{ exceeds: boolean }>(
      await tx.execute(
        sql`select ${input.estimateUsd}::numeric > ${perRun}::numeric as exceeds`,
      ),
    );
    if (row?.exceeds) return exceeded(policy);
  }

  if (policy?.dailyCeilingUsd != null) {
    /*
     * A daily ceiling is a local-day budget, so the boundary is midnight in the
     * workspace's timezone, not UTC. Postgres does the timezone math — it owns
     * the tz database, and `timezone(tz, date_trunc('day', timezone(tz, now())))`
     * is the local midnight as a UTC instant. Both committed and still-open
     * reservations count against it.
     */
    const row = firstRow<{ exceeds: boolean }>(
      await tx.execute(sql`
        with budget_context as (
          select coalesce(
            (select timezone from user_preferences where workspace_id = ${ctx.workspaceId} limit 1),
            'UTC') as tz
        )
        select coalesce(sum(r.reserved_usd), 0) + ${input.estimateUsd}::numeric
                 > ${policy.dailyCeilingUsd}::numeric as exceeds
        from spending_reservations r, budget_context b
        where r.workspace_id = ${ctx.workspaceId}
          and r.status in ('reserved', 'settled')
          and r.created_at >= timezone(b.tz, date_trunc('day', timezone(b.tz, now())))
      `),
    );
    if (row?.exceeds) return exceeded(policy);
  }

  const [reservation] = await tx
    .insert(spendingReservations)
    .values({
      workspaceId: ctx.workspaceId,
      runId: input.runId,
      reservedUsd: input.estimateUsd,
      model: input.model,
    })
    .returning({ id: spendingReservations.id });

  return { ok: true, reservationId: reservation.id };
}

export async function settleSpend(
  tx: TxDrizzle,
  ctx: { workspaceId: string },
  input: { reservationId: string; actualUsd: Money; usage?: unknown },
): Promise<{ wasSettled: boolean }> {
  await workspaceLock(tx, ctx.workspaceId);

  // The `status = 'reserved'` predicate is the idempotency guard: a second
  // settle matches nothing and writes no second settlement row.
  const updated = await tx
    .update(spendingReservations)
    .set({
      status: "settled",
      settledUsd: input.actualUsd,
      settledAt: new Date(),
      updatedAt: new Date(),
      version: sql`${spendingReservations.version} + 1`,
    })
    .where(
      and(
        eq(spendingReservations.id, input.reservationId),
        eq(spendingReservations.workspaceId, ctx.workspaceId),
        eq(spendingReservations.status, "reserved"),
      ),
    )
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

  // No-op on a settled reservation: its money is already spent, and releasing
  // it would hand back budget that was used.
  await tx
    .update(spendingReservations)
    .set({
      status: "released",
      updatedAt: new Date(),
      version: sql`${spendingReservations.version} + 1`,
    })
    .where(
      and(
        eq(spendingReservations.id, input.reservationId),
        eq(spendingReservations.workspaceId, ctx.workspaceId),
        eq(spendingReservations.status, "reserved"),
      ),
    );
}
