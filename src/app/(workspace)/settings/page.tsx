import { io } from "next/cache";
import { Suspense } from "react";
import { getDefaultProfile } from "@/domains/agents/queries";
import { getPreferences } from "@/domains/identity/preferences";
import { getAuthContext } from "@/lib/auth";
import { clerkConfigured } from "@/lib/clerk";
import { capabilityStatus } from "@/lib/capability-config";
import Settings from "@/components/products/command-center/settings";

export const metadata = { title: "Settings · Polymath" };

/*
 * The four owner-facing preferences (timezone, week start, appearance,
 * motion) are server rows now, so the page loads them the same way every
 * other canonical surface does; the panels below save through actions.ts.
 *
 * Capability state is read on the server and passed down: which integrations
 * this deployment has keys for is a server fact, and the panel names the
 * missing variables instead of rendering a control that silently does nothing
 * (ASH-193). Only variable names cross to the client, never values.
 *
 * A deployment without Clerk keys has no account behind this screen at all,
 * so asking for auth throws and the whole route fell into the error boundary
 * - which hid the one panel (capabilities) whose entire job is to describe a
 * not-fully-configured deployment. In that configuration the preferences stay
 * browser-local and the capability panel still renders.
 */

export async function SettingsSurface() {
  await io();
  const capabilities = capabilityStatus();
  if (!clerkConfigured) {
    return <Settings capabilities={capabilities} browserPreview />;
  }
  const auth = await getAuthContext();
  const serverPreferences = await getPreferences(auth);
  // Owner scope, same contract as actions.ts: a non-owner must not receive
  // the raw brief in the initial RSC payload either.
  const serverAssistantProfile = auth.role === "owner" ? await getDefaultProfile(auth) : null;
  return <Settings serverPreferences={serverPreferences} capabilities={capabilities} serverAssistantProfile={serverAssistantProfile} browserPreview={false} />;
}

/*
 * io() has to sit inside a Suspense boundary, not just inside the route:
 * cacheComponents prerenders the shell and rejects uncached data that blocks
 * it. Bare `await io()` in the page default still logs "encountered uncached
 * data during prerendering" and stalls navigation. Unlike connection(), io()
 * still permits the session App Shell to be prefetched.
 */
export default function SettingsPage() {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading settings…</p>}>
      <SettingsSurface />
    </Suspense>
  );
}
