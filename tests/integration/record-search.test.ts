import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifacts } from "@/domains/knowledge/schema";
import { agentProfiles, threads } from "@/domains/agents/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

import { searchRecordsForAttach } from "@/domains/knowledge/record-search";

/*
 * The plus menu's cross-record lookup: only live, titled, workspace-owned
 * rows; generated kinds stay in; conversations surface with a fallback
 * title. No writes anywhere — the reference travels in the message text.
 */

afterAll(async () => {
  await handle?.client.end();
});

suite("record search for attach", () => {
  let auth: { userId: string; workspaceId: string; role: "owner" };
  let otherWorkspace: { userId: string; workspaceId: string };

  beforeAll(async () => {
    holder.db = handle!.db;
    const seeded = await seedWorkspace(handle!.db, `record-search-${Date.now()}`);
    const other = await seedWorkspace(handle!.db, `record-search-other-${Date.now()}`);
    auth = ownerAuth(seeded.userId, seeded.workspaceId);
    otherWorkspace = other;
  });

  async function artifact(input: { kind: (typeof artifacts.kind.enumValues)[number]; title: string; archived?: boolean; workspaceId?: string }) {
    const [row] = await handle!.db
      .insert(artifacts)
      .values({
        workspaceId: input.workspaceId ?? auth.workspaceId,
        kind: input.kind,
        title: input.title,
        status: "reviewed",
        createdBy: auth.userId,
        updatedBy: auth.userId,
        ...(input.archived ? { archivedAt: new Date() } : {}),
      })
      .returning({ id: artifacts.id });
    return row.id;
  }

  it("finds notes, zettels and artifacts by title, grouped with the right hrefs", async () => {
    // Earlier runs of this suite leave rows behind (no truncation here), so
    // titles carry a unique stamp and the assertion looks up this run's ids.
    const stamp = Date.now();
    const noteId = await artifact({ kind: "note", title: `Housing market analysis ${stamp}` });
    const zettelId = await artifact({ kind: "zettel", title: `Housing supply ${stamp}` });
    const deckId = await artifact({ kind: "deck", title: `Housing pitch ${stamp}` });

    // The lookup matches contiguous substrings, so the query is a phrase each
    // title actually contains.
    const results = await searchRecordsForAttach(auth, `analysis ${stamp}`);
    const kinds = new Map(results.map((r) => [r.id, r]));
    expect(kinds.get(noteId)).toMatchObject({ kind: "note", href: `/alfred/notes?note=${noteId}` });
    const zettelResults = await searchRecordsForAttach(auth, `supply ${stamp}`);
    expect(new Map(zettelResults.map((r) => [r.id, r])).get(zettelId)).toMatchObject({
      kind: "zettel",
      href: expect.stringContaining(zettelId),
    });
    const deckResults = await searchRecordsForAttach(auth, `pitch ${stamp}`);
    expect(new Map(deckResults.map((r) => [r.id, r])).get(deckId)).toMatchObject({
      kind: "artifact",
      href: `/alfred/artifacts/${deckId}`,
    });
  });

  it("never returns archived rows, foreign workspaces, or empty titles", async () => {
    const stamp = Date.now();
    await artifact({ kind: "note", title: `Exclusive phrase archived ${stamp}`, archived: true });
    await artifact({ kind: "note", title: `Exclusive phrase foreign ${stamp}`, workspaceId: otherWorkspace.workspaceId });
    await artifact({ kind: "note", title: "" });

    const results = await searchRecordsForAttach(auth, `exclusive phrase ${stamp}`);
    const titles = results.map((r) => r.title);
    expect(titles).not.toContain(`Exclusive phrase archived ${stamp}`);
    expect(titles).not.toContain(`Exclusive phrase foreign ${stamp}`);
    expect(titles).not.toContain("");
  });

  it("surfaces conversations with a fallback title for untitled threads", async () => {
    const [profile] = await handle!.db
      .insert(agentProfiles)
      .values({ workspaceId: auth.workspaceId, name: "record-search-profile" })
      .returning({ id: agentProfiles.id });
    await handle!.db
      .insert(threads)
      .values({ workspaceId: auth.workspaceId, agentProfileId: profile.id, title: null });

    const results = await searchRecordsForAttach(auth, "");
    const conversations = results.filter((r) => r.kind === "conversation");
    expect(conversations.length).toBeGreaterThan(0);
    expect(conversations.every((r) => r.title.length > 0)).toBe(true);
  });
});
