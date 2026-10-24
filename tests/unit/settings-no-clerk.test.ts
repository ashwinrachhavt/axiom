import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/*
 * A deployment without Clerk keys (the current production case) has no
 * account behind /settings. The route used to throw out of getAuthContext
 * and fall into the error boundary, which hid the capability panel - the one
 * panel whose job is describing a not-fully-configured deployment (ASH-193).
 * These tests pin the no-Clerk contract: the page renders the panel without
 * asking for auth, and the preferences actions answer { ok: false } instead
 * of rejecting the server-action call. The failure is the named
 * "not configured" result: the library throw that produced it can carry
 * internal detail, so the authored fallback - not the thrown message - is
 * what crosses the action boundary (same rule as the driver errors).
 */

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), io: async () => undefined }));
vi.mock("@/lib/clerk", () => ({ clerkConfigured: false, devAuthBypass: false }));
vi.mock("@/lib/auth", () => ({
  getAuthContext: vi.fn(async () => {
    throw new Error("auth() threw: Clerk keys are not configured");
  }),
}));
const { getPreferences, updatePreferences } = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));
vi.mock("@/domains/identity/preferences", () => ({ getPreferences, updatePreferences }));
const settingsProps = vi.hoisted(() => ({ fn: vi.fn((props: unknown) => (void props, null)) }));
vi.mock("@/components/products/command-center/settings", () => ({
  default: (props: unknown) => {
    settingsProps.fn(props);
    return null;
  },
}));

import { getAuthContext } from "@/lib/auth";
import { SettingsSurface } from "@/app/(workspace)/settings/page";
import { loadPreferencesAction, savePreferencesAction } from "@/app/(workspace)/settings/actions";

describe("settings page without Clerk configured", () => {
  it("renders the capability panel without asking for auth", async () => {
    const element = await SettingsSurface();
    renderToStaticMarkup(element);
    expect(vi.mocked(getAuthContext)).not.toHaveBeenCalled();
    expect(getPreferences).not.toHaveBeenCalled();
    expect(settingsProps.fn).toHaveBeenCalledTimes(1);
    const props = settingsProps.fn.mock.calls[0][0] as {
      capabilities?: unknown[];
      serverPreferences?: unknown;
    };
    expect(Array.isArray(props.capabilities)).toBe(true);
    expect(props.serverPreferences).toBeUndefined();
  });
});

describe("settings actions without Clerk configured", () => {
  it("loadPreferencesAction returns a named failure instead of throwing", async () => {
    const result = await loadPreferencesAction();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Sign-in is not configured on this deployment.");
      expect(result.error).not.toContain("auth() threw");
    }
    expect(getPreferences).not.toHaveBeenCalled();
  });

  it("savePreferencesAction returns a named failure instead of throwing", async () => {
    const result = await savePreferencesAction({ expectedVersion: 0, timezone: "UTC" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Sign-in is not configured on this deployment.");
    expect(updatePreferences).not.toHaveBeenCalled();
  });
});
