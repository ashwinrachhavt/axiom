import { cache } from "react";
import { auth } from "@clerk/nextjs/server";
import { io } from "next/cache";
import { resolveAuthContext, type AuthContext } from "@/domains/identity/resolve";
import { resolveCompanionToken, resolveMachineClient } from "@/domains/identity/machine";
import { clerkConfigured, devAuthBypass } from "@/lib/clerk";
import { ForbiddenRoleError } from "./auth/guards";
import { problemResponse } from "./problems";

/*
 * The two guards every server entry point goes through. Identity resolution
 * lives in src/domains/identity/ (a domain owns its tables); this file is the
 * thin Clerk-facing shell over it, and the only place UnauthorizedError is
 * turned into a response.
 *
 * Humans authenticate with a Clerk session; agents and the companion with a
 * Clerk machine token (m2m_token / api_key). Both converge on AuthContext, so
 * a route handler does not know or care which one arrived.
 */

export type { AuthContext };

export class UnauthorizedError extends Error {
  readonly code = "unauthorized";

  constructor() {
    super("No signed-in session.");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly code = "forbidden";

  constructor(readonly reason: string) {
    super(reason);
    this.name = "ForbiddenError";
  }
}

export const getAuthContext = cache(async (): Promise<AuthContext> => {
  // Session identity is per-request, so auth can never take part in a
  // prerender. io() suspends during prerendering like connection() did, but
  // unlike connection() it does not block prefetches: the App Shell can still
  // be resolved per session ahead of a click. See the io()/connection() note
  // in Next's Cache Components docs.
  await io();
  // Same dev fallback as getAnyAuthContext below: without Clerk keys the
  // proxy is a no-op and auth() throws. See the longer note there.
  const devFallback = !clerkConfigured || devAuthBypass;
  if (devFallback && process.env.NODE_ENV !== "production" && process.env.VITEST !== "true") {
    // A real session beats the fixed dev owner. Without this the bypass
    // silently rerouted a signed-in browser to dev-user's workspace, so the
    // app rendered one owner's records on a page another owner signed in for.
    // auth() throws rather than returning null when Clerk's middleware is not
    // mounted (devAuthBypass without the proxy), so a throw falls through to
    // the dev owner instead of 500ing every authed route.
    if (clerkConfigured) {
      try {
        const { userId } = await auth();
        if (userId) return resolveAuthContext(userId);
      } catch {
        // No mounted middleware: the bypass owns this request.
      }
    }
    return resolveAuthContext("dev-user");
  }
  const { userId } = await auth();
  if (!userId) throw new UnauthorizedError();
  return resolveAuthContext(userId);
});

/** Every server action begins withAuth(async (auth, input) => ...). */
export function withAuth<A extends unknown[]>(
  fn: (auth: AuthContext, ...args: A) => Promise<unknown>,
) {
  return async (...args: A) => {
    const ctx = await getAuthContext();
    return fn(ctx, ...args);
  };
}

/*
 * Humans OR machines. The Clerk session wins when one exists; otherwise a
 * machine token is resolved against api_clients. Route handlers for /api/v1/**
 * go through this; webhooks keep their HMAC auth instead.
 */
/*
 * Polymath-issued companion tokens. Clerk's API-key product is not enabled on
 * every instance, so the companion's own bearer is verified here: an exact
 * lookup of its digest in api_clients. This sits before Clerk so a companion
 * call never depends on Clerk being reachable or configured.
 */
async function companionFromBearer(request?: Request): Promise<AuthContext | null> {
  const header = request?.headers.get("authorization");
  const secret = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!secret) return null;
  // New-format keys are `axm_<keyId>.<secret>`: the id and the secret's digest
  // are looked up together. Hashing the whole token would miss both halves.
  const resolved = await resolveCompanionToken(secret);
  if (resolved.ok) {
    return {
      userId: resolved.client.clientId,
      workspaceId: resolved.client.workspaceId,
      role: resolved.client.role,
      scopes: resolved.client.scopes,
    };
  }
  // A malformed-but-present bearer for an unknown client is a hard no, not a
  // silent fall-through to the session path.
  if (resolved.reason !== "not_found") throw new ForbiddenError(resolved.reason);
  throw new UnauthorizedError();
}

export const getAnyAuthContext = cache(async (request?: Request): Promise<AuthContext> => {
  const companion = await companionFromBearer(request);
  if (companion) return companion;
  // Dev fallback: without Clerk keys the proxy is a no-op, and Clerk's auth()
  // throws instead of returning "unauthenticated", which turned every authed
  // route into a 500. Resolve a fixed dev owner so a clone boots and serves.
  // gstack-shortcut(dec-qa-001): dev-only owner, upgrade when Clerk keys land
  // in a shared dev env — then delete this branch. Tests mock the Clerk module
  // without touching clerkConfigured's env read, so the flag gates the branch:
  // configured keys always take the real path below.
  const devFallback = !clerkConfigured || devAuthBypass;
  if (devFallback && process.env.NODE_ENV !== "production" && process.env.VITEST !== "true") {
    // A real session beats the fixed dev owner. Without this the bypass
    // silently rerouted a signed-in browser to dev-user's workspace, so the
    // app rendered one owner's records on a page another owner signed in for.
    // auth() throws rather than returning null when Clerk's middleware is not
    // mounted (devAuthBypass without the proxy), so a throw falls through to
    // the dev owner instead of 500ing every authed route.
    if (clerkConfigured) {
      try {
        const { userId } = await auth();
        if (userId) return resolveAuthContext(userId);
      } catch {
        // No mounted middleware: the bypass owns this request.
      }
    }
    return resolveAuthContext("dev-user");
  }
  const session = await auth({ acceptsToken: ["session_token", "m2m_token", "api_key"] });
  if (session.isAuthenticated) {
    if ("userId" in session && session.userId) {
      return resolveAuthContext(session.userId);
    }
    // An m2m/api-key subject: "machineId" for m2m_token, "id" for api_key.
    const subject =
      "machineId" in session ? session.machineId : "id" in session ? session.id : null;
    if (subject) {
      const resolved = await resolveMachineClient(subject);
      if (!resolved.ok) throw new ForbiddenError(resolved.reason);
      return {
        userId: resolved.client.clientId,
        workspaceId: resolved.client.workspaceId,
        role: resolved.client.role,
        scopes: resolved.client.scopes,
      };
    }
  }
  throw new UnauthorizedError();
});

/** For /api/v1/** route handlers; webhooks keep their HMAC auth instead. */
export function authedHandler<C = unknown>(
  fn: (auth: AuthContext, request: Request, ctx: C) => Promise<Response>,
) {
  return async (request: Request, ctx: C): Promise<Response> => {
    try {
      const auth = await getAnyAuthContext(request);
      return await fn(auth, request, ctx);
    } catch (error) {
      if (error instanceof UnauthorizedError)
        return problemResponse(401, "unauthorized", "Sign in to use this endpoint.");
      if (error instanceof ForbiddenError) {
        if (error.reason === "rate_limited")
          return problemResponse(429, "rate_limited", "Daily request ceiling reached.");
        return problemResponse(403, "forbidden", "This client cannot use this endpoint.");
      }
      if (error instanceof ForbiddenRoleError) return problemResponse(403, "forbidden", error.message);
      throw error;
    }
  };
}
