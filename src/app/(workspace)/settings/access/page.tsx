import { io } from "next/cache";
import { Suspense } from "react";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { listInvitations, listMembers } from "@/domains/identity/members";
import { ForbiddenRoleError } from "@/lib/auth/guards";
import { getAuthContext } from "@/lib/auth";

export const metadata = { title: "Access · Polymath" };

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

async function Access() {
  await io();
  const description = "Who belongs to this workspace and which invitations are open. Read-only for now.";
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <Screen title="Access" description={description}>
        <Empty title="Storage is not configured" description="Set DATABASE_URL and apply the database migrations to see members." />
      </Screen>
    );
  }
  const auth = await getAuthContext();
  let members, invites;
  try {
    [members, invites] = await Promise.all([listMembers(auth), listInvitations(auth)]);
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return (
        <Screen title="Access" description={description}>
          <Empty title="Admins only" description="Ask a workspace owner or admin to review who has access." />
        </Screen>
      );
    }
    throw error;
  }

  return (
    <Screen title="Access" description={description}>
      <Panel title="Members" description={`${members.length} in this workspace`}>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 font-medium">Member</th>
              <th className="py-2 font-medium">Role</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2 font-medium">Since</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.membershipId} className="border-b last:border-0">
                <td className="py-2">
                  <p className="font-medium">{m.displayName ?? m.email ?? "Unnamed member"}</p>
                  {m.displayName && m.email && <p className="text-xs text-muted-foreground">{m.email}</p>}
                </td>
                <td className="py-2 capitalize">{m.role}</td>
                <td className="py-2"><Status>{m.status}</Status></td>
                <td className="py-2 text-muted-foreground">{dateFormat.format(m.since)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Invitations" description="An invitation is single-use, expires, and is tied to one email address.">
        {invites.length === 0 ? (
          <Empty title="No invitations" description="Nothing has been sent from this workspace." />
        ) : (
          <ul className="divide-y">
            {invites.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                <span>
                  <span className="font-medium">{i.email}</span>
                  <span className="ml-2 text-xs capitalize text-muted-foreground">{i.role}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">expires {dateFormat.format(i.expiresAt)}</span>
                  <Status>{i.state}</Status>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Screen>
  );
}

/* io() must sit inside a Suspense boundary; see settings/page.tsx. */
export default function AccessPage() {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading access…</p>}>
      <Access />
    </Suspense>
  );
}
