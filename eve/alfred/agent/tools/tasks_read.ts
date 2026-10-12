import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunPolicySnapshot } from "../../../../src/domains/agents/queries";

/*
 * A read capability: it returns rows and touches nothing. Reads still check the
 * frozen snapshot — a run whose profile never granted `tasks.read` must not be
 * able to look, even though looking is cheap. The workspace comes from the
 * session's auth attributes, never from the model's arguments.
 */
export default defineTool({
  description:
    "List the workspace's open tasks. Read-only; the run's frozen policy must allow the tasks.read capability.",
  inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
  async execute(input, ctx) {
    const workspaceId = ctx.session.auth.current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string") return { ok: false as const, error: "no workspace in session" };

    const snapshot = await getRunPolicySnapshot(ctx.session.id, workspaceId);
    if (!toolAllowed(snapshot, "tasks.read")) {
      return { ok: false as const, error: "tasks.read is not in this run's policy snapshot" };
    }

    // ponytail: placeholder read shape; the real projection lands when the Work
    // domain ships its `listOpenTasks` query. The seam being proven is that a
    // read is gated by the frozen snapshot, not how it is shaped.
    return { ok: true as const, tasks: [], limit: input.limit ?? 25 };
  },
});
