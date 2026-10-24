import Link from "next/link";
import { io } from "next/cache";
import { Empty, Screen } from "@/components/workspace/ui";
import { getWikiPageText } from "@/domains/knowledge/wiki";
import { getAuthContext } from "@/lib/auth";

export const metadata = { title: "Wiki page · Polymath" };

/*
 * Read-only reader for a wiki page opened from Artifacts. A wiki page is an
 * artifact of kind "note" claimed by the wiki_pages registry: the Notes
 * editor would offer drafts and saves over text the wiki agent rewrites
 * version by version, so this page renders the current version only and
 * edits stay with the wiki. The domain query owns tenancy; a foreign or
 * non-wiki id renders the empty state, not an error.
 */

export default async function WikiArtifactPage({ params }: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await params;
  await io();
  const auth = await getAuthContext();
  const page = await getWikiPageText(auth, artifactId);

  return (
    <Screen title={page ? page.title : "Wiki page"}>
      {page ? (
        <article className="mx-auto w-full max-w-[720px]">
          <p className="mb-4 text-xs text-muted-foreground">
            Wiki page · version {page.versionNumber} · updated{" "}
            {page.updatedAt.toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </p>
          <div className="whitespace-pre-wrap text-[13px] leading-relaxed">{page.plainText}</div>
        </article>
      ) : (
        <div className="mx-auto w-full max-w-[720px]">
          <Empty
            title="This wiki page is not available."
            description="It may have been regenerated or removed."
            action={
              <Link href="/alfred/artifacts" className="text-[13px] font-medium underline underline-offset-4">
                Back to Artifacts
              </Link>
            }
          />
        </div>
      )}
    </Screen>
  );
}
