import { cache } from "react";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, users, workspaces } from "./schema";

/*
 * Clerk owns authentication; this resolves the internal identity it maps onto.
 * One owner in v1, so the membership lookup is a single row: the first active
 * one, else a freshly provisioned personal workspace.
 *
 * Wrapped in React cache() so parallel server components in one request share
 * a single resolution instead of racing three identical upserts.
 */

export type AuthRole = "owner" | "admin" | "member" | "viewer";

export type AuthContext = {
  userId: string;
  workspaceId: string;
  role: AuthRole;
  /**
   * Machine clients only: the API key's scopes. Undefined for humans, whose
   * role check is the whole guard — requireScope is a no-op for them.
   */
  scopes?: string[];
};

export const resolveAuthContext = cache(async (clerkUserId: string): Promise<AuthContext> => {
  // The common path is one indexed read: an existing user with an active
  // membership. The upsert below used to run on every request and stamp
  // updated_at, turning every page render (and every link prefetch) into a
  // write. Provisioning now only runs when that read finds no active
  // membership.
  const [active] = await db
    .select({ userId: users.id, workspaceId: memberships.workspaceId, role: memberships.role })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(users.clerkUserId, clerkUserId),
        eq(memberships.status, "active"),
        isNull(workspaces.archivedAt),
      ),
    )
    .limit(1);

  if (active) return active;

  // Upsert rather than select-then-insert: two first requests racing on a new
  // account must land on one row, and clerk_user_id is unique for exactly this.
  const [user] = await db
    .insert(users)
    .values({ clerkUserId })
    .onConflictDoUpdate({ target: users.clerkUserId, set: { updatedAt: sql`now()` } })
    .returning();

  const existing = await db
    .select({ workspaceId: memberships.workspaceId, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(memberships.userId, user.id),
        eq(memberships.status, "active"),
        isNull(workspaces.archivedAt),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return { userId: user.id, workspaceId: existing[0].workspaceId, role: existing[0].role };
  }

  // v1: suspended owner still resolves owner; revisit when memberships serve
  // more than one user. With one owner per workspace there is nobody left to
  // hand the workspace to, so the suspended row is the only membership anyway.
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: "Personal", slug: `personal-${user.id}`, isPersonal: true })
    .onConflictDoUpdate({ target: workspaces.slug, set: { updatedAt: sql`now()` } })
    .returning();
  await db
    .insert(memberships)
    .values({ workspaceId: workspace.id, userId: user.id, role: "owner", status: "active" })
    .onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] });
  return { userId: user.id, workspaceId: workspace.id, role: "owner" };
});

/**
 * The role a user currently holds in a workspace, or null when they hold no
 * active membership or the workspace is archived. The gateway runs this on
 * every call: a token names the user and workspace it was minted for, but only
 * the database knows whether that membership still exists.
 */
export async function activeMembershipRole(
  workspaceId: string,
  userId: string,
): Promise<AuthRole | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.status, "active"),
        isNull(workspaces.archivedAt),
      ),
    )
    .limit(1);
  return row?.role ?? null;
}

/**
 * Re-proves a workspace binding that arrived as a claim (the Eve bridge token):
 * the user must hold an active membership in that workspace right now, with the
 * role the claim states, and the workspace must not be archived. Returns the
 * context only on an exact match, so a stale or forged claim gets nothing.
 */
export async function verifyWorkspaceBinding(claim: {
  userId: string;
  workspaceId: string;
  role: AuthRole;
}): Promise<AuthContext | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(memberships.userId, claim.userId),
        eq(memberships.workspaceId, claim.workspaceId),
        eq(memberships.status, "active"),
        isNull(workspaces.archivedAt),
      ),
    )
    .limit(1);
  if (!row || row.role !== claim.role) return null;
  return { userId: claim.userId, workspaceId: claim.workspaceId, role: row.role };
}
