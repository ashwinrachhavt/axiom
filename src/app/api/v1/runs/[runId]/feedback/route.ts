import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { setMessageFeedback } from "@/domains/agents/feedback";

/*
 * POST /api/v1/runs/:runId/feedback — like/dislike one assistant message.
 * The same value again clears it (toggle off); a different value switches.
 */
type Ctx = { params: Promise<{ runId: string }> };

export const POST = authedHandler<Ctx>(async (auth, request, ctx) => {
  requireRole(auth, "member");
  const { runId } = await ctx.params;
  if (!z.string().uuid().safeParse(runId).success) return problemResponse(404, "not_found", "No such run.");
  const body = z
    .object({
      sequence: z.number().int().min(0).optional(),
      turnId: z.string().min(1).max(200).optional(),
      feedback: z.enum(["up", "down", "clear"]),
    })
    .refine((v) => v.sequence !== undefined || v.turnId !== undefined, "Give a sequence or a turnId.")
    .safeParse(await request.json().catch(() => null));
  if (!body.success) return problemResponse(422, "invalid_input", "Give a message sequence or turn id and a feedback value.");

  const result = await setMessageFeedback(auth, {
    runId,
    sequence: body.data.sequence,
    turnId: body.data.turnId,
    feedback: body.data.feedback,
  });
  if (!result.ok) return problemResponse(404, "not_found", "That message is not in this run's thread.");
  return Response.json({ ok: true });
});
