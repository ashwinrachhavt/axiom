import { and, eq, inArray, sql } from "drizzle-orm";
import { settleSpend } from "@/domains/spending/commands";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import {
  agentQuestions,
  agentRuns,
  messages,
  runEvents,
  threads,
  toolCalls,
} from "./schema";

/*
 * The event bridge: the one place eve's observe-only stream events become
 * durable Axiom rows. `run_events` is the timeline the UI reloads from and the
 * SSE cursor, so its sequence claim has to survive eve's at-least-once hook
 * delivery — a replayed event must not double-write, and two writers must not
 * pick the same number.
 *
 * Every write is scoped by workspace as well as run: a run id from another
 * tenant must not land a row, and no caller supplies the owner.
 *
 * Everything goes through the postgres-js transaction driver. `src/lib/db.ts`
 * is the HTTP driver and has no transaction; the sequence claim and the
 * settlement have to commit together with the row they describe.
 */

type MessageRole = (typeof messages.$inferSelect)["role"];
type RunState = (typeof agentRuns.$inferSelect)["state"];

/** The live states a terminal close may flip; mirrors engine.ts's ACTIVE_STATES. */
const ACTIVE_STATES: RunState[] = ["queued", "running", "waiting_input", "waiting_approval"];

const REDACT_KEYS = /token|secret|password|authorization|api[-_]?key|credential/i;

/*
 * Shallow-deep redaction: any key matching REDACT_KEYS is replaced at any nest
 * level. A raw provider payload never reaches a column, and the depth cap keeps
 * a cyclic or pathological payload from walking forever.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEYS.test(key) ? "[redacted]" : redact(entry, depth + 1);
  }
  return out;
}

/*
 * `redact` passes a string through untouched (it is not an object), so error
 * text — where a provider error lands as `...api_key=sk-...` — needs its own
 * pass. Values following a secret-bearing key, and bearer tokens, are masked.
 */
const SECRET_PAIR =
  /((?:token|secret|password|authorization|api[-_]?key|credential)[a-z0-9_-]*["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export function redactText(text: string): string {
  return text.replace(SECRET_PAIR, "$1[redacted]").replace(BEARER, "Bearer [redacted]");
}

/*
 * drizzle-orm 0.45's postgres-js `execute` resolves to a plain array of rows,
 * not a `{ rows }` envelope. Typing that once here keeps every read below from
 * being a cast.
 */
function firstRow<TRow extends Record<string, unknown>>(
  rows: unknown[],
): TRow | undefined {
  return rows[0] as TRow | undefined;
}

/*
 * Proves the run belongs to the caller's workspace before anything is written
 * against it. A run id from another tenant and a run that does not exist are
 * the same error on purpose — the difference is not the caller's to learn. The
 * write is scoped by both columns anyway; this is the guard that makes a
 * cross-workspace call a no-op rather than a row with a mismatched owner.
 */
async function assertRunInWorkspace(
  tx: TxDrizzle,
  runId: string,
  workspaceId: string,
): Promise<void> {
  const run = firstRow<{ id: string }>(
    await tx.execute(
      sql`select id from agent_runs where id = ${runId} and workspace_id = ${workspaceId} limit 1`,
    ),
  );
  if (!run) throw new Error("run not found in workspace");
}

/**
 * Appends one run event and claims its sequence. Must run inside a transaction:
 * the per-run advisory lock, the max+1 read, and the insert commit together or
 * the sequence means nothing.
 */
async function appendEvent(
  tx: TxDrizzle,
  input: { runId: string; workspaceId: string; type: string; data?: unknown },
): Promise<{ sequence: number; deduplicated: boolean }> {
  await assertRunInWorkspace(tx, input.runId, input.workspaceId);

  // Serializes every writer for one run. The (run_id, sequence) conflict target
  // below is the second guard, for a writer that escaped the lock's reach.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.runId}, 0))`);

  const data = input.data ?? null;
  const encoded = data === null ? null : JSON.stringify(data);

  /*
   * A replayed hook re-delivers the identical event — same type, same payload.
   * That equality is the only replay key the schema can hold, because the
   * sequence is assigned here rather than carried on the event: a resumed step
   * re-firing its hook must dedupe, not append a second row. Callers therefore
   * pass the source event's own coordinates inside `data` (see
   * recordUsageEvent), so two genuinely distinct events never collide.
   */
  const existing = firstRow<{ sequence: number }>(
    await tx.execute(sql`
      select sequence from run_events
      where run_id = ${input.runId}
        and type = ${input.type}
        and data is not distinct from ${encoded}::jsonb
      limit 1
    `),
  );
  if (existing) return { sequence: existing.sequence, deduplicated: true };

  const next = firstRow<{ next: number }>(
    await tx.execute(
      sql`select coalesce(max(sequence), 0) + 1 as next from run_events where run_id = ${input.runId}`,
    ),
  );
  const sequence = next?.next ?? 1;

  const inserted = await tx
    .insert(runEvents)
    .values({ workspaceId: input.workspaceId, runId: input.runId, type: input.type, data, sequence })
    .onConflictDoNothing({ target: [runEvents.runId, runEvents.sequence] })
    .returning({ sequence: runEvents.sequence });
  if (inserted.length === 0) {
    const row = firstRow<{ sequence: number }>(
      await tx.execute(
        sql`select sequence from run_events where run_id = ${input.runId} and sequence = ${sequence} limit 1`,
      ),
    );
    return { sequence: row?.sequence ?? sequence, deduplicated: true };
  }

  // greatest() so a resumed writer cannot lower the cursor SSE reconnect reads.
  await tx.execute(
    sql`update agent_runs set last_event_seq = greatest(last_event_seq, ${sequence}) where id = ${input.runId}`,
  );
  return { sequence, deduplicated: false };
}

/**
 * The single write point for a run timeline event. One transaction: lock,
 * sequence, insert, cursor bump.
 */
export async function recordRoundEvent(input: {
  runId: string;
  workspaceId: string;
  type: string;
  data?: unknown;
}): Promise<{ sequence: number; deduplicated: boolean }> {
  return withTransaction((tx) => appendEvent(tx, input));
}

/**
 * Append-only tool result. Arguments and output are redacted before insert —
 * a tool call is exactly where a provider token would otherwise be persisted.
 */
export async function recordToolCall(input: {
  workspaceId: string;
  runId: string;
  stepId?: string;
  toolName: string;
  ok: boolean;
  durationMs?: number;
  args?: unknown;
  result?: unknown;
  errorCode?: string;
}): Promise<void> {
  await withTransaction(async (tx) => {
    await assertRunInWorkspace(tx, input.runId, input.workspaceId);
    await tx.insert(toolCalls).values({
      workspaceId: input.workspaceId,
      runId: input.runId,
      stepId: input.stepId ?? null,
      toolName: input.toolName,
      ok: input.ok,
      errorCode: input.errorCode ?? null,
      durationMs: input.durationMs ?? null,
      arguments: redact(input.args) ?? null,
      result: redact(input.result) ?? null,
    });
  });
}

/**
 * A durable question. The run suspends on it, so it gets both the row the
 * Reviews/Inbox surface reads and a timeline event the SSE stream can announce.
 * One transaction: the question row and its announcing event commit together, so
 * a failure leaves neither.
 */
export async function recordQuestion(input: {
  workspaceId: string;
  runId: string;
  question: string;
  context?: string;
  options?: unknown;
}): Promise<void> {
  await withTransaction(async (tx) => {
    await assertRunInWorkspace(tx, input.runId, input.workspaceId);
    const [row] = await tx
      .insert(agentQuestions)
      .values({
        workspaceId: input.workspaceId,
        runId: input.runId,
        question: input.question,
        context: input.context ?? null,
        options: (redact(input.options ?? []) ?? []) as unknown[],
      })
      .returning({ id: agentQuestions.id });
    await appendEvent(tx, {
      runId: input.runId,
      workspaceId: input.workspaceId,
      type: "question.opened",
      data: { questionId: row.id, question: input.question },
    });
  });
}

/**
 * Token/cost usage for one model step, appended to the run timeline. The
 * terminal close sums these rows in SQL — cost is `numeric`, never a JS float,
 * and the running total is derived rather than stored.
 *
 * `source` carries the step's coordinates so two steps reporting identical
 * token counts are two rows, not one deduped replay.
 */
export async function recordUsageEvent(input: {
  workspaceId: string;
  runId: string;
  usage: Record<string, unknown>;
  source?: Record<string, unknown>;
}): Promise<{ sequence: number; deduplicated: boolean }> {
  return recordRoundEvent({
    runId: input.runId,
    workspaceId: input.workspaceId,
    type: "usage",
    data: input.source ? { ...input.usage, source: input.source } : input.usage,
  });
}

/**
 * Mirrors one session message into the transcript the Alfred chat UI reads.
 * The run owns its thread: the first message creates it, every later one joins
 * it. `runId` is populated so the message can be traced back to its run.
 */
export async function mirrorMessage(input: {
  workspaceId: string;
  runId: string;
  role: MessageRole;
  content: string;
  parts?: unknown;
}): Promise<void> {
  await withTransaction(async (tx) => {
    // Lock the run row: two concurrent messages must share one thread, and the
    // read-then-create below is a race without it.
    const [run] = await tx
      .select({ threadId: agentRuns.threadId, agentProfileId: agentRuns.agentProfileId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.workspaceId, input.workspaceId)))
      .for("update")
      .limit(1);
    if (!run) throw new Error("run not found in workspace");

    let threadId = run.threadId;
    if (!threadId) {
      const [thread] = await tx
        .insert(threads)
        .values({ workspaceId: input.workspaceId, agentProfileId: run.agentProfileId })
        .returning({ id: threads.id });
      threadId = thread.id;
      await tx
        .update(agentRuns)
        .set({ threadId, updatedAt: new Date() })
        .where(eq(agentRuns.id, input.runId));
    }

    await tx.insert(messages).values({
      workspaceId: input.workspaceId,
      threadId,
      role: input.role,
      content: input.content,
      parts: input.parts ?? null,
      runId: input.runId,
    });
  });
}

/** The accumulated usage across a run's `usage` events, summed as numeric in SQL. */
type UsageTotals = {
  usd: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

/**
 * Closes a run: terminal event, state flip, and settlement, in one transaction.
 *
 * The flip is conditional on an active state, so terminal states stay
 * immutable — a second close matches no row and writes nothing, which is also
 * what makes the settle idempotent (there is no second path to the reservation).
 */
export async function closeRun(input: {
  workspaceId: string;
  runId: string;
  state: Extract<RunState, "succeeded" | "failed" | "cancelled">;
  summary?: string;
  error?: string;
}): Promise<{ closed: boolean; settledUsd: string | null }> {
  return withTransaction(async (tx) => {
    const endedAt = new Date();
    const flipped = await tx
      .update(agentRuns)
      .set({
        state: input.state,
        endedAt,
        updatedAt: endedAt,
        summary: input.summary ?? null,
        // Schema rule: redacted failure detail, never a raw provider payload.
        error: input.error === undefined ? null : redactText(input.error),
      })
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.workspaceId, input.workspaceId),
          inArray(agentRuns.state, ACTIVE_STATES),
        ),
      )
      .returning({ id: agentRuns.id });
    if (flipped.length === 0) return { closed: false, settledUsd: null };

    await appendEvent(tx, {
      runId: input.runId,
      workspaceId: input.workspaceId,
      type: `run.${input.state}`,
      data: { summary: input.summary ?? null },
    });

    const totals = firstRow<UsageTotals>(
      await tx.execute(sql`
        select
          coalesce(sum((data->>'costUsd')::numeric), 0)::text as usd,
          coalesce(sum((data->>'inputTokens')::bigint), 0)::int as input_tokens,
          coalesce(sum((data->>'outputTokens')::bigint), 0)::int as output_tokens,
          coalesce(sum((data->>'cacheReadTokens')::bigint), 0)::int as cache_read_tokens,
          coalesce(sum((data->>'cacheWriteTokens')::bigint), 0)::int as cache_write_tokens
        from run_events
        where run_id = ${input.runId} and type = 'usage'
      `),
    );
    const actualUsd = totals?.usd ?? "0";

    const open = firstRow<{ id: string }>(
      await tx.execute(sql`
        select id from spending_reservations
        where run_id = ${input.runId}
          and workspace_id = ${input.workspaceId}
          and status = 'reserved'
        limit 1
      `),
    );

    let settledUsd: string | null = null;
    if (open) {
      // Scoped to the workspace and guarded on status = 'reserved' inside
      // settleSpend, so a released or already-settled claim is a no-op.
      const settled = await settleSpend(
        tx,
        { workspaceId: input.workspaceId },
        {
          reservationId: open.id,
          actualUsd,
          usage: {
            inputTokens: totals?.input_tokens ?? 0,
            outputTokens: totals?.output_tokens ?? 0,
            cacheReadTokens: totals?.cache_read_tokens ?? 0,
            cacheWriteTokens: totals?.cache_write_tokens ?? 0,
            costUsd: actualUsd,
          },
        },
      );
      if (settled.wasSettled) settledUsd = actualUsd;
    }

    return { closed: true, settledUsd };
  });
}
