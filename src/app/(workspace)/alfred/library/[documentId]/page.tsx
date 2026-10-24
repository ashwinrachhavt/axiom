import Link from "next/link";
import { Suspense } from "react";
import { io } from "next/cache";
import { notFound } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { getAuthContext } from "@/lib/auth";
import { getReadableDocument } from "@/domains/knowledge/reading";
import { listPassages, segmentText } from "@/domains/knowledge/passages";
import { ReadingShell } from "./reading-tracker";

export const metadata = { title: "Read · Polymath" };

/*
 * The focused reader: the document's extracted text, the owner's folded
 * reading position, and the tracker that keeps both honest. The original
 * file stays in Knowledge - this surface reads the extraction, so a failed
 * or pending read says so instead of showing nothing.
 */

async function ReaderSurface({ documentId }: { documentId: string }) {
  await io();
  const auth = await getAuthContext();
  const doc = await getReadableDocument(auth, documentId);
  if (!doc) notFound();

  const passages = await listPassages(auth, doc.id);
  const progress = doc.state?.furthestProgress ?? 0;

  return (
    <div className="flex flex-col">
      <PageHeader
        title={doc.title}
        purpose={
          doc.kind === "web_page" && doc.sourceUrl
            ? `Saved from ${new URL(doc.sourceUrl).hostname}`
            : (doc.mimeType ?? "Document")
        }
        actions={
          <Link
            href="/alfred/library"
            className="text-[13px] text-muted-foreground underline-offset-4 hover:underline"
          >
            Back to library
          </Link>
        }
      />
      <div className="flex flex-col gap-5 page-content">
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="progressbar"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Reading progress"
            className="h-1 w-40 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-foreground/70" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <Readout className="text-xs text-muted-foreground">
            {Math.round(progress * 100)}% · {Math.round((doc.state?.totalActiveSeconds ?? 0) / 60)} min ·{" "}
            {doc.state?.openCount ?? 0} {doc.state?.openCount === 1 ? "open" : "opens"}
          </Readout>
        </div>
        {!doc.extraction || doc.extraction.status === "pending" || doc.extraction.status === "skipped" ? (
          <p role="status" className="text-[13px] text-muted-foreground">
            Still reading this document. Check back shortly.
          </p>
        ) : doc.extraction.status === "failed" ? (
          <p role="alert" className="text-[13px] text-destructive">
            This document could not be read{doc.extraction.error ? `: ${doc.extraction.error}` : "."} Re-run
            extraction from Knowledge.
          </p>
        ) : (
          <ReadingShell
            documentId={doc.id}
            segments={segmentText(doc.extraction.text ?? "", passages)}
            canSave={auth.role !== "viewer"}
          />
        )}
      </div>
    </div>
  );
}

export default function ReaderPage({ params }: { params: Promise<{ documentId: string }> }) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-3 page-content">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      }
    >
      <ReaderSurfaceFromParams params={params} />
    </Suspense>
  );
}

async function ReaderSurfaceFromParams({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  return <ReaderSurface documentId={documentId} />;
}
