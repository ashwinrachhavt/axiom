"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import {
  registerAccount,
  renameAccount,
  revokeConnectedAccount,
  setAccountAccessTier,
  setAccountCapability,
  setDefaultForWrites,
} from "@/domains/integrations/commands";
import { attachProviderLink, beginConnection, failConnectionAttempt } from "@/domains/integrations/connect";
import { resolveRequestOrigin } from "@/domains/integrations/origin";
import { createHostedConnectLink } from "@/domains/integrations/composio";
import { syncGoogleCalendarAccount } from "@/domains/calendar/google-sync";
import { syncNotionAccount } from "@/domains/integrations/notion";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Connector actions (D09 foundation). These manage Polymath's bookkeeping rows
 * only. The OAuth handshake itself is scaffolding for now: registering an
 * account opens a `connecting` row, and the Composio hosted-auth redirect +
 * callback that would flip it to `active` lands with the provider work. No
 * provider is called and nothing is written externally from here.
 */

type Result = { ok: true } | { ok: false; error: string };

const revalidate = () => revalidatePath("/command-center/integrations");

async function authorize() {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

function fail(error: unknown): Result {
  return { ok: false, error: error instanceof Error ? error.message : "The connector write failed." };
}

export async function registerAccountAction(input: { provider: string; alias: string }): Promise<Result> {
  const auth = await authorize();
  if (!input.alias.trim()) return { ok: false, error: "An alias is required - models choose accounts by alias." };
  try {
    await registerAccount(auth, { provider: input.provider, alias: input.alias.trim() });
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function setWriteDefaultAction(input: { accountId: string; expectedVersion: number }): Promise<Result> {
  const auth = await authorize();
  try {
    await setDefaultForWrites(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

export async function setAccountAccessTierAction(input: {
  accountId: string;
  expectedVersion: number;
  tierId: string;
}): Promise<Result> {
  const auth = await authorize();
  try {
    await setAccountAccessTier(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

/*
 * and every read in the workspace, not just from the person clicking. The read
 * and send paths re-check `status = 'active'` per call, so this needs no cache
 * invalidation to take effect - only the page refresh below so the card
 * reflects it.
 */
export async function revokeAccountAction(input: { accountId: string; expectedVersion: number }): Promise<Result> {
  const auth = await getAuthContext();
  requireRole(auth, "admin");
  try {
    await revokeConnectedAccount(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

/*
 * The OAuth handshake: begin the attempt, ask Composio for the hosted link,
 * store it, hand the browser the hosted URL. Connect never asks for a name
 * first — with no alias the flow names the account itself and the owner can
 * rename it afterwards. When the link cannot be created the attempt is
 * marked failed with the real reason at once: nothing is left in
 * `connecting` to rot into a misleading "expired".
 */
export async function startConnectionAction(input: { provider: string; alias?: string }): Promise<
  { ok: true; redirectUrl: string } | { ok: false; error: string }
> {
  const auth = await authorize();
  const alias = input.alias?.trim() ?? "";
  try {
    const { account, attempt } = await beginConnection(auth, {
      provider: input.provider,
      ...(alias ? { alias } : {}),
    });
    // The state token is what lets the callback find this attempt. Without it
    // every OAuth return landed on "missing-state" and the account sat in
    // `connecting` forever, which is what a connect that "did nothing" was.
    //
    // APP_ORIGIN wins when set; without it the callback belongs to the origin
    // the browser actually used. The old localhost fallback sent a hosted
    // deployment's OAuth return to localhost:3000, so the attempt never
    // completed and the card said "expired" for a flow that had finished.
    // The forwarded host is client-supplied, so it is only trusted when the
    // platform confirms it is this deployment's own (resolveRequestOrigin).
    const requestHeaders = await headers();
    const resolved = resolveRequestOrigin({
      host: requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"),
      proto: requestHeaders.get("x-forwarded-proto"),
    });
    if (!resolved.ok) {
      const reason = resolved.error;
      await failConnectionAttempt(auth, { accountId: account.id, reason });
      return { ok: false, error: reason };
    }
    const callbackUrl = new URL("/api/integrations/callback", resolved.origin);
    callbackUrl.searchParams.set("state", attempt.stateToken);
    let link;
    try {
      link = await createHostedConnectLink({
        provider: input.provider,
        userId: auth.workspaceId,
        callbackUrl: callbackUrl.toString(),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The connection could not start.";
      await failConnectionAttempt(auth, { accountId: account.id, reason });
      return { ok: false, error: reason };
    }
    await attachProviderLink(auth, {
      attemptId: attempt.id,
      redirectUrl: link.redirectUrl,
      connectedAccountId: link.connectedAccountId,
    });
    return { ok: true, redirectUrl: link.redirectUrl };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The connection could not start." };
  }
}

/* One capability switched off (or back on) for one account. The tier stays the ceiling. */
export async function setAccountCapabilityAction(input: {
  accountId: string;
  expectedVersion: number;
  capability: string;
  enabled: boolean;
}): Promise<Result> {
  const auth = await authorize();
  try {
    await setAccountCapability(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

/* Naming happens after connect, not before it. */
export async function renameAccountAction(input: {
  accountId: string;
  expectedVersion: number;
  alias: string;
}): Promise<Result> {
  const auth = await authorize();
  try {
    await renameAccount(auth, input);
  } catch (error) {
    return fail(error);
  }
  revalidate();
  return { ok: true };
}

/* Read-only pull of the owner's Google Calendar into the week view. Nothing is written to Google. */
export async function syncGoogleCalendarAction(input: { accountId: string }): Promise<
  { ok: true; summary: string } | { ok: false; error: string }
> {
  const auth = await authorize();
  try {
    const r = await syncGoogleCalendarAccount(auth, { externalAccountId: input.accountId });
    revalidatePath("/apps/neuralflow/tasks");
    revalidate();
    return { ok: true, summary: `${r.created} new, ${r.updated} updated, ${r.cancelled} cancelled` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The calendar sync failed." };
  }
}

/* Read-only pull of shared Notion pages into knowledge documents. Nothing is written to Notion. */
export async function syncNotionAction(input: { accountId: string }): Promise<
  { ok: true; summary: string } | { ok: false; error: string }
> {
  const auth = await authorize();
  try {
    const r = await syncNotionAccount(auth, { externalAccountId: input.accountId });
    revalidate();
    return { ok: true, summary: `${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged, ${r.failed} failed` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The Notion sync failed." };
  }
}
