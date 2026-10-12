import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
import { withTransaction } from "../../../../src/lib/db-transaction";
import { createProposal } from "../../../../src/domains/actions/commands";
import { getRunPolicySnapshot } from "../../../../src/domains/agents/queries";

/*
 * An external-write capability. The handler does the one thing a consequential
 * action is allowed to do under Axiom policy: it writes an action_proposals row
 * with a preview and a dedupe key. It never calls Gmail — the send happens
 * later, from the approved attempt, outside this process. A model instruction
 * cannot escalate past that: there is no provider client here to call.
 *
 * No eve approval gate: the proposal IS the human gate. Gating twice would ask
 * the owner to approve a draft of an approval.
 */
export default defineTool({
  description:
    "Propose sending an email. Creates a reviewable proposal for the owner; it does not send. The run's frozen policy must allow the gmail.send capability.",
  inputSchema: z.object({
    to: z.string().describe("Recipient address"),
    subject: z.string(),
    body: z.string(),
    messageId: z.string().describe("Provider message id this replies to, for dedupe"),
    accountAlias: z.string().optional().describe("Which connected Gmail account, e.g. work-gmail"),
  }),
  async execute(input, ctx) {
    const workspaceId = ctx.session.auth.current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string") return { ok: false as const, error: "no workspace in session" };

    const snapshot = await getRunPolicySnapshot(ctx.session.id, workspaceId);
    if (!toolAllowed(snapshot, "gmail.send")) {
      return { ok: false as const, error: "gmail.send is not in this run's policy snapshot" };
    }

    // Deterministic from the intent: a resumed step or a retry re-derives the
    // same key and resolves the existing proposal rather than a second send.
    const dedupeKey = `gmail.send:${workspaceId}:${input.messageId}`;

    const { proposalId, deduplicated } = await withTransaction((tx) =>
      createProposal(
        tx,
        { workspaceId },
        {
          capability: "gmail.send",
          riskClass: "external_write",
          targetType: "message",
          accountAlias: input.accountAlias,
          title: `Send "${input.subject}"`,
          expectedEffect: `Sends an email to ${input.to} from ${input.accountAlias ?? "the default account"}`,
          dedupeKey,
          runId: ctx.session.id,
          // An external write the owner has not decided on inside a day is stale.
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        },
      ),
    );

    return { ok: true as const, proposalId, deduplicated, status: "awaiting review" };
  },
});
