import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { searchRecordsForAttach } from "@/domains/knowledge/record-search";

/*
 * GET /api/v1/records/search?q= — cross-record lookup for the composer's
 * plus menu (notes, zettels, artifacts, conversations). Read-only; the
 * picker inserts a markdown link into the message text, so this endpoint
 * never writes anything. Members and above.
 */

type Ctx = { params: Promise<Record<string, string | string[] | undefined>> };

export const GET = authedHandler<Ctx>(async (auth, request) => {
  requireRole(auth, "member");
  const url = new URL(request.url);
  const parsed = z.string().max(200).safeParse(url.searchParams.get("q") ?? "");
  if (!parsed.success) return problemResponse(422, "invalid_input", "Give a query of up to 200 characters.");
  const records = await searchRecordsForAttach(auth, parsed.data);
  return Response.json({ records });
});
