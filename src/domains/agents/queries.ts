import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRuns } from "./schema";

/*
 * A run's frozen policy snapshot, read back for the tools that must honour it.
 * Scoped by workspace as well as run: a run id from another tenant and a run
 * that does not exist return the same null, because the difference is not the
 * caller's to learn.
 */
export async function getRunPolicySnapshot(
  runId: string,
  workspaceId: string,
): Promise<unknown | null> {
  const [run] = await db
    .select({ policySnapshot: agentRuns.policySnapshot })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, workspaceId)))
    .limit(1);
  return run?.policySnapshot ?? null;
}
