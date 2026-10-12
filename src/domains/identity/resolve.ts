import { cache } from "react";
import { and, eq, isNull } from "drizzle-orm";
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
};

export const resolveAuthContext = cache(async (clerkUserId: string): Promise<AuthContext> => {
  // Upsert rather than select-then-insert: two first requests racing on a new
  // account must land on one row, and clerk_user_id is unique for exactly this.
  const [user] = await db
    .insert(users)
    .values({ clerkUserId })
    .onConflictDoUpdate({ target: users.clerkUserId, set: { updatedAt: new Date() } })
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
    .onConflictDoUpdate({ target: workspaces.slug, set: { updatedAt: new Date() } })
    .returning();
  await db
    .insert(memberships)
    .values({ workspaceId: workspace.id, userId: user.id, role: "owner", status: "active" })
    .onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] });
  return { userId: user.id, workspaceId: workspace.id, role: "owner" };
});
