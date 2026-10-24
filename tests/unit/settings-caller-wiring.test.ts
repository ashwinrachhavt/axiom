import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The mode flag must follow the caller's actual execution mode, not just a
 * manually supplied prop: the /settings route passes browserPreview from
 * clerkConfigured (its established preview switch), and the command-center
 * dispatch threads it through, defaulting unknown callers to account mode
 * (which never makes no-egress claims).
 */

const settingsProps = vi.hoisted(() => ({ fn: vi.fn((props: unknown) => (void props, null)) }));
const dispatched = vi.hoisted(() => ({ fn: vi.fn((props: unknown) => (void props, null)) }));
vi.mock("@/components/products/command-center/settings", () => ({
  default: (props: unknown) => settingsProps.fn(props),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), io: async () => undefined }));

const clerk = vi.hoisted(() => ({ clerkConfigured: true }));
vi.mock("@/lib/clerk", () => clerk);

vi.mock("@/lib/auth", () => ({
  getAuthContext: vi.fn(async () => ({ userId: "u", workspaceId: "w", role: "owner" })),
}));
vi.mock("@/domains/identity/preferences", () => ({
  getPreferences: vi.fn(async () => ({ timezone: "UTC", weekStart: 1, appearance: "system", motion: "full", version: 1 })),
}));
vi.mock("@/domains/agents/queries", () => ({ getDefaultProfile: vi.fn(async () => null) }));
vi.mock("@/lib/capability-config", () => ({ capabilityStatus: vi.fn(() => []) }));

import { SettingsSurface } from "@/app/(workspace)/settings/page";

describe("/settings route wiring", () => {
  beforeEach(() => settingsProps.fn.mockClear());

  it("passes browserPreview=false when Clerk is configured (authenticated mode)", async () => {
    clerk.clerkConfigured = true;
    renderToStaticMarkup(await SettingsSurface());
    expect(settingsProps.fn.mock.calls[0][0]).toMatchObject({ browserPreview: false });
  });

  it("passes browserPreview=true when no Clerk keys exist (browser preview)", async () => {
    clerk.clerkConfigured = false;
    renderToStaticMarkup(await SettingsSurface());
    expect(settingsProps.fn.mock.calls[0][0]).toMatchObject({ browserPreview: true });
  });
});

describe("command-center dispatch wiring", () => {
  it("threads browserPreview to the settings screen and defaults unknown callers to account mode", async () => {
    vi.doMock("next/dynamic", () => ({
      default: () => (props: unknown) => dispatched.fn(props),
    }));
    vi.resetModules();
    const { default: CommandCenterScreen } = await import("@/components/products/command-center/screen-dispatch");

    renderToStaticMarkup(h(CommandCenterScreen, { screen: "settings", browserPreview: true }));
    expect(dispatched.fn.mock.calls[0][0]).toMatchObject({ browserPreview: true });

    dispatched.fn.mockClear();
    renderToStaticMarkup(h(CommandCenterScreen, { screen: "settings" }));
    expect(dispatched.fn.mock.calls[0][0]).toMatchObject({ browserPreview: false });
  });
});
