/*
 * One problem+json shape across the API (RFC 9457). Codes are added, never
 * repurposed: a client switching on `code` must not change meaning when a new
 * failure is introduced somewhere else.
 */
export function problemResponse(status: number, code: string, title: string): Response {
  return Response.json(
    { type: `https://axiom.dev/problems/${code}`, code, title, status },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}
