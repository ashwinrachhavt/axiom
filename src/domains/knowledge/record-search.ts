import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { artifacts, type artifactKind } from "@/domains/knowledge/schema";
import { threads } from "@/domains/agents/schema";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * Cross-record lookup for the composer's plus menu: when the owner attaches
 * context to a message, they search everything the message could name —
 * notes, zettels, generated artifacts, and past conversations. One query,
 * grouped by kind client-side. Read-only; the reference travels in the
 * message text, so this module never writes anything.
 *
 * LIMIT is fixed rather than caller-supplied: the menu shows a handful per
 * group, and an unbounded typeahead against the workspace's own tables is a
 * cost for no UX gain.
 */

const PER_GROUP_LIMIT = 5;

export type RecordReference = {
  id: string;
  kind: "note" | "zettel" | "artifact" | "conversation";
  title: string;
  /** Where the picker sends a click: the record's own screen. */
  href: string;
};

export async function searchRecordsForAttach(
  auth: AuthContext,
  query: string,
): Promise<RecordReference[]> {
  const trimmed = query.trim().slice(0, 200);
  const like = `%${escapeLike(trimmed)}%`;

  // The enum's members the picker offers. "wiki" is not a db kind; the filter
  // below admits it only as a display kind, mapped from "note" rows the wiki
  // registry would claim — this query stays registry-agnostic.
  const artifactKinds: (typeof artifactKind.enumValues)[number][] = [
    "note", "zettel", "report", "deck", "infographic",
    "document", "memo", "diagram", "transcript", "other",
  ];

  const [artifactRows, threadRows] = await Promise.all([
    db
      .select({ id: artifacts.id, kind: artifacts.kind, title: artifacts.title, updatedAt: artifacts.updatedAt })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.workspaceId, auth.workspaceId),
          inArray(artifacts.kind, [...artifactKinds]),
          isNull(artifacts.archivedAt),
          // An untitled row has no name to attach or search by.
          sql`${artifacts.title} <> ''`,
          trimmed ? ilike(artifacts.title, like) : sql`true`,
        ),
      )
      .orderBy(desc(artifacts.updatedAt))
      .limit(PER_GROUP_LIMIT * 3),
    db
      .select({ id: threads.id, title: threads.title, updatedAt: threads.updatedAt })
      .from(threads)
      .where(
        and(
          eq(threads.workspaceId, auth.workspaceId),
          isNull(threads.archivedAt),
          trimmed ? ilike(threads.title, like) : sql`true`,
        ),
      )
      .orderBy(desc(threads.updatedAt))
      .limit(PER_GROUP_LIMIT),
  ]);

  const references: RecordReference[] = artifactRows
    // The picker's groups; document/other/memo/diagram/transcript rows do not
    // belong in a message-reference menu, they have their own surfaces.
    .filter((row) => ["note", "zettel", "report", "deck", "infographic"].includes(row.kind))
    .map((row) => ({
      id: row.id,
      kind: row.kind === "zettel" ? "zettel" : row.kind === "note" ? "note" : "artifact",
      title: row.title,
      href:
        row.kind === "note"
          ? `/alfred/notes?note=${row.id}`
          : row.kind === "zettel"
            ? `/alfred/knowledge/zettels?zettel=${row.id}`
            : `/alfred/artifacts/${row.id}`,
    }));
  references.push(
    ...threadRows.map((row) => ({
      id: row.id,
      kind: "conversation" as const,
      title: row.title || "Untitled conversation",
      href: `/command-center/conversations/${row.id}`,
    })),
  );
  return references;
}
