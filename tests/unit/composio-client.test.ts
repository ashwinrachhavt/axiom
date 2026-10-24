import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The Composio client: request shape, env gating, error surfaces. No network. */

describe("composio client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports not-configured without env, per provider", async () => {
    const { isComposioConfigured, createHostedConnectLink } = await import("@/domains/integrations/composio");
    expect(await isComposioConfigured("gmail")).toBe(false);
    await expect(
      createHostedConnectLink({ provider: "gmail", userId: "ws-1", callbackUrl: "https://app.test/cb" }),
    ).rejects.toMatchObject({ code: "composio_not_configured" });
  });

  it("discovers per-provider auth configs from the project key when no override is set", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/auth_configs")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              { id: "ac_gmail_new", toolkit: { slug: "gmail" }, status: "ENABLED" },
              { id: "ac_gmail_old", toolkit: { slug: "gmail" }, status: "ENABLED" },
              { id: "ac_slack", toolkit: { slug: "slack" }, status: "ENABLED" },
              { id: "ac_gcal", toolkit: { slug: "googlecalendar" }, status: "ENABLED" },
              { id: "ac_disabled", toolkit: { slug: "linear" }, status: "DISABLED" },
            ],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ redirect_url: "https://hosted.composio.dev/x", connected_account_id: "ca_1", expires_at: "2026-10-19T02:00:00Z" }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { isComposioConfigured, createHostedConnectLink, resetAuthConfigDiscovery } = await import(
      "@/domains/integrations/composio"
    );
    resetAuthConfigDiscovery();
    try {
      expect(await isComposioConfigured("gmail")).toBe(true);
      expect(await isComposioConfigured("google-calendar")).toBe(true); // kebab-case provider matches concatenated slug
      expect(await isComposioConfigured("linear")).toBe(false); // disabled config grants nothing

      await createHostedConnectLink({ provider: "gmail", userId: "ws-1", callbackUrl: "https://app.test/cb" });
      const linkCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/connected_accounts/link"));
      expect(linkCall).toBeDefined();
      expect(JSON.parse(String(linkCall![1].body)).auth_config_id).toBe("ac_gmail_new"); // newest wins
    } finally {
      resetAuthConfigDiscovery();
    }
  });

  it("posts the link session with the auth config for the provider", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    vi.stubEnv("COMPOSIO_AUTH_CONFIG_GMAIL", "ac_gmail_1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirect_url: "https://hosted.composio.dev/x", connected_account_id: "ca_1", expires_at: "2026-10-19T02:00:00Z" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { isComposioConfigured, createHostedConnectLink } = await import("@/domains/integrations/composio");
    expect(await isComposioConfigured("gmail")).toBe(true);
    expect(await isComposioConfigured("slack")).toBe(false); // per-provider config

    const link = await createHostedConnectLink({
      provider: "gmail",
      userId: "ws-1",
      callbackUrl: "https://app.test/cb",
    });
    expect(link).toEqual({ redirectUrl: "https://hosted.composio.dev/x", connectedAccountId: "ca_1", expiresAt: "2026-10-19T02:00:00Z" });

    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).includes("/connected_accounts/link")) as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    // No `alias`: Composio rejects an alias already held by any connected
    // account under the same user_id (400, code 600), and local/Composio
    // alias stores drift. The hosted flow resolves by state token instead.
    expect(JSON.parse(String(init.body))).toEqual({
      auth_config_id: "ac_gmail_1",
      user_id: "ws-1",
      callback_url: "https://app.test/cb",
    });
  });

  it("surfaces a failed link request as a plain error, never the key", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key-secret");
    vi.stubEnv("COMPOSIO_AUTH_CONFIG_NOTION", "ac_notion_1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    const { createHostedConnectLink } = await import("@/domains/integrations/composio");
    await expect(
      createHostedConnectLink({ provider: "notion", userId: "ws-1", callbackUrl: "https://app.test/cb" }),
    ).rejects.toThrow(/failed \(401\)/);
    await expect(
      createHostedConnectLink({ provider: "notion", userId: "ws-1", callbackUrl: "https://app.test/cb" }),
    ).rejects.not.toThrow(/test-key-secret/);
  });
});
