import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
 * The settings route's initial render is an entry path of its own: guarding
 * the server actions alone would still serialize the owner's raw brief into
 * the RSC payload of any member or viewer who opens /settings. The page must
 * not even call the profile read for a non-owner, and the client must
 * receive no brief props (the section is omitted, which also reveals nothing
 * about whether a brief exists).
 */

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), io: async () => undefined }));
vi.mock("@/lib/clerk", () => ({ clerkConfigured: true, devAuthBypass: false }));
const authHolder: { ctx: { userId: string; workspaceId: string; role: "owner" | "viewer" } } = {
  ctx: { userId: "usr_1", workspaceId: "ws_1", role: "viewer" },
};
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => authHolder.ctx) }));
vi.mock("@/lib/capability-config", () => ({ capabilityStatus: () => [] }));
const { getDefaultProfile, getPreferences } = vi.hoisted(() => ({
  getDefaultProfile: vi.fn(async () => ({ name: "Polymath", description: "secret brief", instructions: "secret instructions", version: 3 })),
  getPreferences: vi.fn(async () => ({})),
}));
vi.mock("@/domains/agents/queries", () => ({ getDefaultProfile }));
vi.mock("@/domains/identity/preferences", () => ({ getPreferences }));
const settingsProps = vi.hoisted(() => ({ fn: vi.fn((props: unknown) => (void props, null)) }));
vi.mock("@/components/products/command-center/settings", () => ({
  default: (props: unknown) => {
    settingsProps.fn(props);
    return null;
  },
}));

import { SettingsSurface } from "@/app/(workspace)/settings/page";

describe("settings page assistant-brief scope", () => {
  it("a non-owner render never calls the profile read and receives no brief props", async () => {
    authHolder.ctx = { userId: "usr_1", workspaceId: "ws_1", role: "viewer" };
    getDefaultProfile.mockClear();
    settingsProps.fn.mockClear();
    renderToStaticMarkup(await SettingsSurface());
    expect(getDefaultProfile).not.toHaveBeenCalled();
    const props = settingsProps.fn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props.serverAssistantProfile ?? null).toBeNull();
    expect(JSON.stringify(props)).not.toContain("secret");
  });

  it("an owner render reads the profile once and passes it through", async () => {
    authHolder.ctx = { userId: "usr_1", workspaceId: "ws_1", role: "owner" };
    getDefaultProfile.mockClear();
    settingsProps.fn.mockClear();
    renderToStaticMarkup(await SettingsSurface());
    expect(getDefaultProfile).toHaveBeenCalledTimes(1);
    const props = settingsProps.fn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props.serverAssistantProfile).toMatchObject({ name: "Polymath", version: 3 });
  });
});
