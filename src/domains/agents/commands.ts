import type postgres from "postgres";

/*
 * The orphaned-run remedy. A run whose worker died — a Vercel function evicted,
 * a crash between the queued row and the session — stays `queued`/`running`
 * forever, holding a spending reservation against the daily ceiling that no
 * caller will ever settle. This sweep is what closes it.
 *
 * Deliberately not a domain command: it takes the raw postgres-js client
 * because a cron sweep runs outside any request, has no AuthContext, and spans
 * every workspace. It cannot use closeRun, which is scoped to one workspace and
 * one auth. `for update skip locked` is the concurrency guard, so two
 * overlapping sweeps cannot both claim the same run.
 *
 * The two active states and the error text are constants, so they are inlined:
 * the sweep is the only writer, and a bound array makes postgres-js guess
 * parameter types (it mis-inferred a sibling Date as text, a `bytes.js` throw).
 * Ids stay bound — an `in` list of uuids is exactly what a parameter is for.
 */

/** The live states the run table's partial active index covers. */
const ACTIVE_IN = "'queued', 'running'";
const TIMED_OUT = "run timed out and was reconciled";

/**
 * Marks every queued/running run created before `olderThanMs` ago as failed,
 * releases its open spending reservation, and leaves one `run.reconciled`
 * event. Returns the ids it closed, for the caller's log or metric.
 */
export async function reconcileStaleRuns(
  rawClient: ReturnType<typeof postgres>,
  olderThanMs: number = 24 * 3600 * 1000,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const now = new Date().toISOString();

  return rawClient.begin(async (tx) => {
    const stale = await tx<{ id: string }[]>`
      select id from agent_runs
      where state::text in (${tx.unsafe(ACTIVE_IN)})
        and created_at < ${cutoff}::timestamptz
      for update skip locked
    `;
    if (stale.length === 0) return [];

    const ids = stale.map((row) => row.id);

    await tx`
      update agent_runs
      set state = 'failed',
          error = ${TIMED_OUT},
          ended_at = ${now}::timestamptz,
          updated_at = ${now}::timestamptz,
          version = version + 1
      where id = any(${ids})
    `;

    // Release, not settle: the run did no work, so its budget goes back. Guarded
    // on status = 'reserved' so a settled or already-released claim is untouched.
    await tx`
      update spending_reservations
      set status = 'released',
          updated_at = ${now}::timestamptz,
          version = version + 1
      where run_id = any(${ids}) and status = 'reserved'
    `;

    // One event per run, sequence claimed with max+1 — the shape appendEvent
    // uses, so a live SSE reader sees the close.
    await tx`
      insert into run_events (workspace_id, run_id, sequence, type, data, created_at)
      select r.workspace_id, r.id,
             coalesce((select max(e.sequence) from run_events e where e.run_id = r.id), 0) + 1,
             'run.reconciled',
             ${JSON.stringify({ error: TIMED_OUT })}::jsonb,
             ${now}::timestamptz
      from agent_runs r
      where r.id = any(${ids})
    `;

    await tx`
      update agent_runs
      set last_event_seq = greatest(last_event_seq,
            (select max(sequence) from run_events e where e.run_id = agent_runs.id))
      where id = any(${ids})
    `;

    return ids;
  });
}
