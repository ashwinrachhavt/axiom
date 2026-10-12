import { and, eq } from "drizzle-orm";
import type { TxDrizzle } from "@/lib/db-transaction";
import { actionProposals } from "./schema";

/*
 * The only write path that turns model intent into an external effect. A tool
 * never calls a provider: it proposes, and the proposal carries the preview, the
 * risk class, and the dedupe key a human decides on.
 *
 * Dedupe is the guardrail, not a convenience. `(workspace_id, dedupe_key)` is
 * unique, so a replayed run — a resumed step, an at-least-once hook, a retry —
 * resolves the existing proposal instead of creating a second effect. The
 * insert loses the race on purpose and the read that follows returns the winner.
 */

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
    .where(
      and(
        eq(actionProposals.workspaceId, ctx.workspaceId),
        eq(actionProposals.dedupeKey, input.dedupeKey),
      ),
    )
    .limit(1);
  // ponytail: racy caller deleted the row between insert and select; treat as
  // retryable failure, not a TypeError, when the contract next changes.
  if (!existing) throw new Error("proposal vanished during dedupe resolve");
  return { proposalId: existing.id, deduplicated: true };
}
