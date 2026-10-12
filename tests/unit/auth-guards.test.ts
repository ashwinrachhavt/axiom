import { describe, expect, it, vi } from "vitest";

vi.mock("@/domains/identity/resolve", () => ({
  resolveAuthContext: vi.fn(async () => ({ userId: "u", workspaceId: "w", role: "owner" })),
}));
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId })) }));

let userId: string | undefined;
import { authedHandler, getAuthContext, UnauthorizedError } from "@/lib/auth";

describe("auth guards", () => {
  it("authedHandler returns 401 problem+json when unauthenticated", async () => {
    userId = undefined;
    const handler = authedHandler(async () => new Response("ok"));
    const res = await handler(new Request("https://axiom.dev/api/v1/x"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = await res.json();
    expect(body.code).toBe("unauthorized");
  });

  it("authedHandler passes AuthContext through when authenticated", async () => {
    userId = "clerk_x";
    const handler = authedHandler(async (auth) => new Response(auth.workspaceId));
    const res = await handler(new Request("https://axiom.dev/api/v1/x"));
    expect(await res.text()).toBe("w");
  });

  it("getAuthContext throws UnauthorizedError when unauthenticated", async () => {
    userId = undefined;
    await expect(getAuthContext()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
