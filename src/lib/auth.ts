import { cache } from "react";
import { auth } from "@clerk/nextjs/server";
import { resolveAuthContext, type AuthContext } from "@/domains/identity/resolve";
import { problemResponse } from "./problems";

/*
 * The two guards every server entry point goes through. Identity resolution
 * lives in src/domains/identity/ (a domain owns its tables); this file is the
 * thin Clerk-facing shell over it, and the only place UnauthorizedError is
 * turned into a response.
 */

export type { AuthContext };

export class UnauthorizedError extends Error {
  readonly code = "unauthorized";

  constructor() {
    super("No signed-in session.");
    this.name = "UnauthorizedError";
  }
}

export const getAuthContext = cache(async (): Promise<AuthContext> => {
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

/** For /api/v1/** route handlers; webhooks keep their HMAC auth instead. */
export function authedHandler(fn: (auth: AuthContext, request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      const ctx = await getAuthContext();
      return await fn(ctx, request);
    } catch (error) {
      if (error instanceof UnauthorizedError)
        return problemResponse(401, "unauthorized", "Sign in to use this endpoint.");
      throw error;
    }
  };
}
