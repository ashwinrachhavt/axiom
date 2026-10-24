import Link from "next/link";
import { Suspense } from "react";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { getAuthContext } from "@/lib/auth";
import type { RawSearchParams } from "@/lib/list-params";
import { listDossiers } from "@/domains/knowledge/dossiers";
import { getDraftDetail } from "@/domains/knowledge/studio";
import { artifactNextStep } from "@/domains/knowledge/continuation";
import { DraftWorkbench } from "./draft-workbench";
import { listLinkableRecords, resolveLinkTitles } from "./links";
import { CreateDossierForm } from "./create-dossier-form";

export const metadata = { title: "Notebook · Polymath" };

/*
 * The notebook screen: the workspace's notebooks and the form that creates one.
 * A notebook opens as its notebook view — sources on the left, the grounded
 * conversation in the middle, Studio on the right — so everything else lives
 * there, not here. Creating one is naming it; sources join in the Sources pane.
 */
const BASE = "/alfred/dossiers";

export async function DossiersSurface({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await io();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Notebook" />
        <div className="page-content">
          <EmptyState
            title="Notebook storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to create notebooks and generate from them."
          />
        </div>
      </>
    );
  }
  const auth = await getAuthContext();
  const raw = await searchParams;
  const draftId = typeof raw.draft === "string" ? raw.draft : undefined;
  const dossiers = await listDossiers(auth);
  // A draft id that is missing, foreign, or not a Studio artifact opens no
  // workbench; only the link's sender knows the difference, and the page still
  // renders the list.
  const draftDetail = draftId ? await getDraftDetail(auth, draftId) : null;
  const [linkTitles, linkable] = draftDetail
    ? await Promise.all([resolveLinkTitles(auth, draftDetail.links), listLinkableRecords(auth)])
    : [{}, null];

  return (
    <>
      <PageHeader title="Notebook" />
      <div className="flex flex-col gap-8 page-content">
        <Section title="Your notebooks">
          {dossiers.length === 0 ? (
            <EmptyState title="No notebooks yet" />
          ) : (
            <ul className="flex flex-col gap-1">
              {dossiers.map((dossier) => (
                <li key={dossier.id}>
                  <Link
                    href={`${BASE}/${dossier.id}/notebook`}
                    className="flex items-baseline gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent"
                  >
                    <span className="font-medium">{dossier.title}</span>
                    <span className="text-muted-foreground">
                      {dossier.documentCount} {dossier.documentCount === 1 ? "document" : "documents"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="New notebook">
          <CreateDossierForm />
        </Section>

        {draftDetail && linkable ? (
          <Section title="Draft workbench">
            <DraftWorkbench
              suggestedNextStep={artifactNextStep(draftDetail.artifact.status, draftDetail.pendingRevisions)}
              artifact={draftDetail.artifact}
              versions={draftDetail.versions}
              text={draftDetail.text}
              sources={draftDetail.sources}
              links={draftDetail.links}
              linkTitles={linkTitles}
              linkable={linkable}
            />
          </Section>
        ) : null}
      </div>
    </>
  );
}

export default function DossiersPage(props: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<DossiersSkeleton />}>
      <DossiersSurface {...props} />
    </Suspense>
  );
}

function DossiersSkeleton() {
  return (
    <div role="status" aria-label="Loading Notebook" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-40" />
    </div>
  );
}
