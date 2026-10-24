import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { getAuthContext } from "@/lib/auth";
import type { RawSearchParams } from "@/lib/list-params";
import { ApplyTitleButton, ClassificationDecisions, FieldDecisions, ObligationDecisions, PartyDecisions, ProposeZettelsButton, ZettelDecisions } from "./decision-buttons";
import { listZettelProposals } from "@/domains/knowledge/zettels";
import { RetryExtractionButton } from "./retry-extraction-button";
import { RetryCaptureButton } from "./retry-capture-button";
import { documentStatus, type DocumentStatusTone } from "@/domains/knowledge/status";
import { RULES_PROPOSER } from "@/domains/knowledge/field-rules";
import { fieldLabel } from "./field-display";
import { getOpenClassification } from "@/domains/knowledge/classify";
import { sentenceCase, suggestTitle } from "@/domains/knowledge/naming";
import {
  getDocumentReview,
  type DocumentReviewParty,
} from "@/domains/knowledge/queries";
import { resolvePartyCandidates } from "@/domains/knowledge/parties";
import { Suspense } from "react";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { listFolders } from "@/domains/knowledge/library";
import { getVaultDocuments } from "@/domains/knowledge/vault-queries";
import { statementForDocument } from "@/domains/knowledge/statement-import";
import { judgeTransactions } from "@/domains/knowledge/transaction-rules";
import { summarize, type Judgment } from "@/domains/knowledge/transaction-classify";
import { StatementPanel, type StatementPanelData } from "./statement-panel";
import { DocumentVault } from "./vault";


export const metadata = { title: "Knowledge · Polymath" };

/*
 * The document vault. The screen is three things: a search field, a quiet +,
 * and the vault itself — folders as tiles, documents as rows. Everything that
 * was here before (search section, sources, learning, filter toolbar) was
 * removed on the owner's direction; the review workbench (?doc=<id>) stays as
 * the detail view, and Zettels keeps its own tab.
 */

const toneGlyph: Record<DocumentStatusTone, React.ReactNode> = {
  neutral: <Circle className="size-3 text-muted-foreground" aria-hidden />,
  progress: <LoaderCircle className="text-muted-foreground size-3" aria-hidden />,
  attention: <TriangleAlert className="size-3 text-amber-600 dark:text-amber-400" aria-hidden />,
  done: <CheckCircle2 className="size-3 text-teal-600 dark:text-teal-400" aria-hidden />,
  error: <CircleAlert className="text-destructive size-3" aria-hidden />,
};

const toneClass: Record<DocumentStatusTone, string> = {
  neutral: "text-muted-foreground",
  progress: "text-muted-foreground",
  attention: "text-amber-700 dark:text-amber-400",
  done: "text-teal-700 dark:text-teal-400",
  error: "text-destructive",
};

export function StatusBadge({ label, tone }: { label: string; tone: DocumentStatusTone }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${toneClass[tone]}`}>
      {toneGlyph[tone]}
      <span>{label}</span>
    </span>
  );
}

function pageDomain(sourceUrl: string | null): string {
  if (!sourceUrl) return "page";
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return "page";
  }
}

export async function KnowledgeSurface({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  // Per-request data; streams inside the Suspense boundary below.
  await io();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Knowledge" purpose="Write, retrieve, and connect." />
        <div className="page-content">
          <EmptyState
            title="Knowledge storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to upload and review documents. Extraction also requires private Blob storage (BLOB_READ_WRITE_TOKEN, or Vercel OIDC with BLOB_STORE_ID) and a hosted reader (DOCLING_SERVE_URL, REDUCTO_API_KEY or LLAMAPARSE_API_KEY, or OCR_PROVIDER=openrouter)."
          />
        </div>
      </>
    );
  }
  const auth = await getAuthContext();
  const raw = await searchParams;
  const params = {
    doc: typeof raw.doc === "string" ? raw.doc : undefined,
    folder: typeof raw.folder === "string" && raw.folder ? raw.folder : null,
  };
  const review = params.doc ? await getDocumentReview(auth, { documentId: params.doc }) : null;

  if (review) {
    // The detail view: decisions are the whole screen when one document is open.
    const partyOptions = new Map(
      (await resolvePartyCandidates(auth, { documentId: review.document.id }).catch(() => [])).map(
        (o: { partyId: string; options: unknown }) => [o.partyId, o.options],
      ),
    );
    const classification = await getOpenClassification(auth, review.document.id);
    const classificationValue = classification as Awaited<ReturnType<typeof getOpenClassification>> | null;
    const suggestedTitle = suggestTitle(
      review.document.docType ?? (classificationValue?.proposedType ?? ""),
      Object.fromEntries(
        review.fieldProposals
          .filter((p) => p.status === "accepted" && (p.acceptedValue ?? p.normalizedValue) != null)
          .map((p) => [
            p.fieldName,
            typeof (p.acceptedValue ?? p.normalizedValue) === "string"
              ? String(p.acceptedValue ?? p.normalizedValue)
              : JSON.stringify(p.acceptedValue ?? p.normalizedValue),
          ]),
      ),
    );
    const statement = await statementForDocument(auth, review.document.id);
    const judgments = statement ? await judgeTransactions(auth, statement.transactions) : [];
    return (
      <ReviewWorkbench
        review={review}
        zettels={await listZettelProposals(auth, review.document.id)}
        partyOptions={partyOptions as never}
        suggestedTitle={suggestedTitle && suggestedTitle !== review.document.title ? suggestedTitle : null}
        classification={classificationValue}
        statement={statement}
        judgments={judgments}
      />
    );
  }

  const [folders, vaultDocuments] = await Promise.all([
    listFolders(auth),
    getVaultDocuments(auth, params.folder),
  ]);

  const breadcrumb: { name: string; href: string | null }[] = [];
  if (params.folder) {
    const chain: { name: string; href: string | null }[] = [];
    let current = folders.find((f) => f.id === params.folder) ?? null;
    while (current) {
      chain.unshift({ name: current.name, href: current.id === params.folder ? null : `/alfred/knowledge?folder=${current.id}` });
      current = current.parentId ? (folders.find((f) => f.id === current!.parentId) ?? null) : null;
    }
    breadcrumb.push({ name: "Vault", href: "/alfred/knowledge" }, ...chain);
  }

  return (
    <>
      <PageHeader title="Knowledge" purpose="Write, retrieve, and connect." />

      <nav aria-label="Knowledge views" className="flex gap-1 border-b border-border">
        <span aria-current="page" className="border-b-2 border-foreground px-3 py-1.5 text-[13px] font-medium">Documents</span>
        <Link href="/alfred/knowledge/zettels" className="px-3 py-1.5 text-[13px] text-muted-foreground underline-offset-2 hover:underline">
          Zettels
        </Link>
        <Link href="/alfred/knowledge/cards" className="px-3 py-1.5 text-[13px] text-muted-foreground underline-offset-2 hover:underline">
          Cards
        </Link>
        <Link href="/alfred/knowledge/areas" className="px-3 py-1.5 text-[13px] text-muted-foreground underline-offset-2 hover:underline">
          Areas
        </Link>
      </nav>

      <div className="page-content">
        <DocumentVault
          folders={folders.map((f) => ({ id: f.id, parentId: f.parentId, name: f.name, documentCount: f.documentCount }))}
          documents={vaultDocuments}
          currentFolderId={params.folder}
          breadcrumb={breadcrumb}
        />

      </div>
    </>
  );
}

/** Three zones: document info on the left, field and party decisions center, obligations right. */
/*
 * The domain returns database rows; the panel renders a small view model. This
 * is the one place the two shapes meet, so a column rename stays inside the
 * domain instead of reaching into the component.
 */
function statementPanelData(
  statement: Awaited<ReturnType<typeof statementForDocument>>,
  judgments: Judgment[],
): StatementPanelData | null {
  if (!statement) return null;
  const reconciliation = statement.import.reconciliation as {
    strategy?: string;
    totals?: { status?: string; checks?: Array<{ label: string; stated: string; computed: string; ok: boolean }> };
    mismatches?: Array<{
      occurredOn: string;
      description: string;
      amount: string;
      expectedBalance: string;
      actualBalance: string;
    }>;
  };
  return {
    status: statement.import.status,
    accountLabel: statement.import.accountLabel,
    periodStart: statement.import.periodStart,
    periodEnd: statement.import.periodEnd,
    openingBalance: statement.import.openingBalance,
    closingBalance: statement.import.closingBalance,
    transactionCount: statement.import.transactionCount,
    reconciled: statement.import.reconciled,
    error: statement.import.error,
    mismatches: reconciliation.mismatches ?? [],
    strategy: reconciliation.strategy,
    totalsStatus: reconciliation.totals?.status,
    categoryTotals: Object.entries(
      summarize(statement.transactions, judgments.length === statement.transactions.length ? judgments : []).byCategory,
    )
      .map(([category, value]) => ({ category, ...value! }))
      .filter((entry) => entry.category !== "unknown" && Number(entry.spent) > 0)
      .sort((a, b) => Number(b.spent) - Number(a.spent))
      .slice(0, 8),
    rows: statement.transactions.map((row, index) => ({
      id: row.id,
      occurredOn: row.occurredOn,
      description: row.description,
      amount: row.amount,
      category: judgments[index]?.category,
      needsReview: judgments[index]?.route === "review",
    })),
  };
}

function ReviewWorkbench({
  review,
  partyOptions,
  suggestedTitle,
  classification,
  zettels,
  statement,
  judgments,
}: {
  zettels: Awaited<ReturnType<typeof listZettelProposals>>;
  review: NonNullable<Awaited<ReturnType<typeof getDocumentReview>>>;
  partyOptions: Map<string, { kind: "contact" | "company"; id: string; name: string; via: string }[]>;
  suggestedTitle: string | null;
  classification: Awaited<ReturnType<typeof getOpenClassification>> | null;
  statement: Awaited<ReturnType<typeof statementForDocument>>;
  judgments: Judgment[];
}) {
  const { document: doc, extraction, fieldProposals, parties, obligations } = review;
  const status = documentStatus(extraction, fieldProposals.filter((p) => p.status === "proposed").length);
  const undecided = fieldProposals.filter((p) => p.status === "proposed");

  return (
    <div className="flex flex-col gap-4">
      <Link href="/alfred/knowledge" className="text-muted-foreground w-fit text-xs underline-offset-4 hover:underline">
        Back to vault
      </Link>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1.5fr)]">
        {/* Left: document info */}
        <div className="flex flex-col gap-3">
          <div className="panel rounded-lg px-3.5 py-3 transition-colors hover:bg-muted/40">
            <h3 className="text-[13px] font-medium">{doc.title}</h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {doc.sourceUrl ? (
                <>
                  {"Web page · "}
                  <a href={doc.sourceUrl} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                    {pageDomain(doc.sourceUrl)}
                  </a>
                </>
              ) : (
                (doc.mimeType ?? "File")
              )}
            </p>
            <div className="mt-2">
              <StatusBadge label={status.label} tone={status.tone} />
            </div>
            {extraction?.status === "failed" && extraction.error ? (
              <p role="alert" className="text-destructive mt-2 text-xs">
                {extraction.error}
              </p>
            ) : null}
            {extraction?.status === "succeeded" && extraction.proposalStatus === "failed" && extraction.proposalError ? (
              <p role="alert" className="text-destructive mt-2 text-xs">
                {extraction.proposalError}
              </p>
            ) : null}
            {extraction?.status === "succeeded" && extraction.proposalStatus === null ? (
              <p className="text-muted-foreground mt-2 text-xs">
                The text was read, but no fields have been proposed from it yet.
              </p>
            ) : null}
            {extraction?.status === "pending" || extraction === null ? (
              <p className="text-muted-foreground mt-2 text-xs">
                {extraction === null
                  ? "The file has not been read yet."
                  : "The document is being read."}
              </p>
            ) : null}
          </div>
          {extraction === null || extraction.status === "failed" ? (
            <RetryExtractionButton documentId={doc.id} label={extraction === null ? "Read now" : "Retry"} />
          ) : extraction.status === "succeeded" &&
            (extraction.proposalStatus === null || extraction.proposalStatus === "failed") ? (
            <RetryExtractionButton
              documentId={doc.id}
              label={extraction.proposalStatus === null ? "Propose fields" : "Retry proposing fields"}
            />
          ) : null}
          <StatementPanel
            documentId={doc.id}
            extractionSucceeded={extraction?.status === "succeeded"}
            statement={statementPanelData(statement, judgments)}
          />
          {extraction?.status === "failed" && doc.sourceUrl ? (
            <RetryCaptureButton url={doc.sourceUrl} />
          ) : null}
          {doc.docType ? (
            <p className="text-muted-foreground text-xs">
              Classified as <span className="font-medium text-foreground">{doc.docType}</span>.
            </p>
          ) : classification ? (
            <ClassificationDecisions
              proposalId={classification.id}
              proposedType={classification.proposedType}
              confidence={classification.confidence}
              signals={classification.signals}
              expectedVersion={classification.version}
            />
          ) : null}
          {suggestedTitle ? (
            <ApplyTitleButton
              documentId={doc.id}
              title={suggestedTitle}
              expectedVersion={doc.version}
            />
          ) : null}
        </div>

        {/* Center: field proposals and parties */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <h3 className="text-[13px] font-medium">Extracted fields</h3>
            {extraction?.proposer === RULES_PROPOSER && fieldProposals.length > 0 ? (
              <p className="text-muted-foreground text-xs">
                Proposed by text rules, not AI. Check each value against the line it was read from.
              </p>
            ) : null}
            {undecided.length === 0 && fieldProposals.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                {extraction?.status === "succeeded"
                  ? "Nothing was extracted — the document had no readable fields."
                  : "Fields appear here once the document is read."}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {fieldProposals.map((proposal) => (
                  <li key={proposal.id} className="panel rounded-lg px-3.5 py-3 transition-colors hover:bg-muted/40">
                    <p className="text-[13px] font-medium">{sentenceCase(fieldLabel(proposal.fieldName))}</p>
                    {proposal.evidenceQuote ? (
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        Read from: <q className="text-foreground">{proposal.evidenceQuote}</q>
                      </p>
                    ) : null}
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {proposal.confidence ? `Confidence: ${proposal.confidence}.` : ""}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      Reads as{" "}
                      <span className="text-foreground">{proposal.normalizedValue != null ? String(proposal.normalizedValue) : "nothing readable"}</span>
                    </p>
                    {proposal.status === "proposed" ? (
                      <div className="mt-2">
                        <FieldDecisions
                          proposalId={proposal.id}
                          fieldName={fieldLabel(proposal.fieldName)}
                          readable={proposal.normalizedValue != null}
                        />
                      </div>
                    ) : (
                      <p className="text-muted-foreground mt-1 text-xs">
                        {proposal.status === "accepted" ? "Accepted" : "Rejected"}
                        {proposal.acceptedValue != null
                          ? ` — ${typeof proposal.acceptedValue === "string" ? proposal.acceptedValue : JSON.stringify(proposal.acceptedValue)}`
                          : ""}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Parties parties={parties} optionsByParty={partyOptions} />
        </div>

        {/* Right: obligations */}
        <div className="flex flex-col gap-3">
          <h3 className="text-[13px] font-medium">Proposed follow-up work</h3>
          {obligations.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              Nothing proposed — no unpaid totals or missing fields were found.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {obligations.map((obligation) => (
                <li key={obligation.id} className="panel rounded-lg px-3.5 py-3 transition-colors hover:bg-muted/40">
                  <p className="text-[13px]">{obligation.note ?? obligation.kind}</p>
                  {obligation.status === "proposed" ? (
                    <div className="mt-2">
                      <ObligationDecisions obligationId={obligation.id} />
                    </div>
                  ) : (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {obligation.status === "accepted"
                        ? "Accepted — a task was created."
                        : obligation.status === "rejected"
                          ? "Rejected"
                          : "Superseded by a newer document"}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h3 className="mt-2 text-[13px] font-medium">Proposed zettels</h3>
          {extraction?.status === "succeeded" ? <ProposeZettelsButton documentId={doc.id} /> : null}
          {zettels.length === 0 ? (
            <p className="text-muted-foreground text-xs">No zettels proposed yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {zettels.map((z) => (
                <li key={z.id} className="panel rounded-lg px-3.5 py-3 transition-colors hover:bg-muted/40">
                  <p className="text-[13px] font-medium">{z.title}</p>
                  <p className="text-[13px]">{z.claim}</p>
                  <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                    &ldquo;{z.quote}&rdquo; · chars {z.spanStart}-{z.spanEnd}
                  </p>
                  {z.status === "proposed" ? (
                    <div className="mt-2">
                      <ZettelDecisions proposalId={z.id} />
                    </div>
                  ) : (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {z.status === "accepted" ? "Accepted. Concept and evidence link written." : "Rejected"}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Parties({
  parties,
  optionsByParty,
}: {
  parties: DocumentReviewParty[];
  optionsByParty: Map<string, { kind: "contact" | "company"; id: string; name: string; via: string }[]>;
}) {
  if (parties.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium">People and companies</h3>
        <p className="text-muted-foreground text-xs">None were found in this document.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[13px] font-medium">People and companies</h3>
      <ul className="flex flex-col gap-2">
        {parties.map((party) => (
          <li key={party.id} className="panel rounded-lg px-3.5 py-3 transition-colors hover:bg-muted/40">
            <p className="text-[13px] font-medium">
              {party.displayName}{" "}
              <span className="text-muted-foreground font-normal">
                · {sentenceCase(party.partyRole)}
              </span>
            </p>
            {party.resolutionStatus === "unresolved" ? (
              <div className="mt-2">
                <PartyDecisions
                  partyId={party.id}
                  displayName={party.displayName}
                  partyKind={party.partyKind}
                  options={optionsByParty.get(party.id) ?? []}
                />
              </div>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs">
                {party.resolutionStatus === "matched" || party.resolutionStatus === "created"
                  ? `Linked to ${(party.contactName ?? party.companyName) ?? "a record"}`
                  : "Marked as not part of this document"}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  return (
    <Suspense fallback={<KnowledgeSkeleton />}>
      <KnowledgeSurface searchParams={searchParams} />
    </Suspense>
  );
}

function KnowledgeSkeleton() {
  return (
    <div role="status" aria-label="Loading Knowledge" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-8 w-full max-w-md" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-2/3" />
    </div>
  );
}
