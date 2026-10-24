import { io } from "next/cache";
import Link from "next/link";
import { listCorrespondence } from "@/domains/crm/correspondence";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import {
  getContactDetail,
  listCompanies,
  pageCompanies,
  listContacts,
  RELATIONSHIP_STATUSES,
  type RelationshipStatus,
} from "@/domains/crm/queries";
import { RELATIONSHIP_STATUS_LABELS } from "@/domains/crm/status";
import { getAuthContext } from "@/lib/auth";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, parsePageNumber } from "@/lib/list-params";
import { findCompanyDuplicates, findContactDuplicates } from "@/domains/crm/dedupe";
import { ContactForm } from "../contact-form";
import { DuplicatesPanel } from "../duplicates-panel";
import {
  ArchiveContactButton,
  CancelCorrespondenceButton,
  CorrespondenceForm,
  RequestSendApprovalButton,
  FollowUpForm,
  ObservationForm,
  ResolveFollowUpButton,
  SendApprovedButton,
} from "../contact-detail-controls";
import { CompanyForm } from "../company-form";
import { ResearchCompanyButton } from "../research-button";

export const metadata = { title: "Contacts · Polymath" };

/*
 * The CRM contact workspace under the Relationships section (ASH-139 C01): contacts,
 * observations and follow-ups read from Postgres. The browser-preview store
 * that used to render here is retired for this domain; the LinkedIn CSV
 * import stays as its own strip because it writes the identity domain's
 * people/organizations, whose merge with CRM contacts is ASH-135 item 2.
 *
 * Filters are URL state (GET form), so a filtered view is a shareable link
 * and the list is a plain server render with no client fetching.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}



async function Relationships({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  await io();
  const auth = await getAuthContext();
  const list = parseListParams(query, { filters: { status: RELATIONSHIP_STATUSES } });
  const q = list.q || undefined;
  const status = list.filters.status as RelationshipStatus | undefined;
  const companyPage = parsePageNumber(query.cpage);
  const rawId = first(query.id);
  const selectedId = rawId && /^[0-9a-fA-F-]{36}$/.test(rawId) ? rawId : undefined;
  const invalidSelection = !!rawId && !selectedId;

  // A selected contact is its own surface: the management screen around it is
  // chrome the detail does not need, and fetching the list to render it wastes
  // the request. Only the detail and the company picker load here.
  if (selectedId || invalidSelection) {
    const [detail, allCompanies] = await Promise.all([
      selectedId ? getContactDetail(auth, { contactId: selectedId }) : Promise.resolve(null),
      // The edit form's picker needs every company, not just a visible page.
      listCompanies(auth),
    ]);
    const correspondence = detail ? await listCorrespondence(auth, { contactId: detail.contact.id }) : [];
    const companyOptions = allCompanies.map((company) => ({ id: company.id, name: company.name }));

    return (
      <Screen
        title="Contacts"
        actions={
          <Link href="/command-center/relationships/contacts" className="text-[13px] font-medium underline-offset-4 hover:underline">
            Open contact list
          </Link>
        }
      >
        {invalidSelection ? (
          <Empty
            title="Contact not found"
            description="This record link is not a valid contact id. No contact was selected."
            action={
              <Button asChild variant="outline">
                <Link href="/command-center/relationships/contacts">Open contact list</Link>
              </Button>
            }
          />
        ) : detail ? (
          <ContactDetailPanel detail={detail} companies={companyOptions} correspondence={correspondence} />
        ) : (
          <Empty
            title="Contact not found"
            description="This record link does not match a contact in this workspace. No other contact was selected."
            action={
              <Button asChild variant="outline">
                <Link href="/command-center/relationships/contacts">Open contact list</Link>
              </Button>
            }
          />
        )}
      </Screen>
    );
  }

  const [contactsPage, companyPageData, allCompanies, contactDuplicates, companyDuplicates] = await Promise.all([
    listContacts(auth, { query: q, status, limit: list.pageSize, offset: offsetFor(list.page, list.pageSize) }),
    pageCompanies(auth, { limit: list.pageSize, offset: offsetFor(companyPage, list.pageSize) }),
    // The pickers in the forms need every company, not just the visible page.
    listCompanies(auth),
    findContactDuplicates(auth),
    findCompanyDuplicates(auth),
  ]);
  redirectPastEnd("/command-center/relationships/contacts", query, list.page, list.pageSize, contactsPage.total);
  redirectPastEnd("/command-center/relationships/contacts", query, companyPage, list.pageSize, companyPageData.total, "cpage");

  const companyOptions = allCompanies.map((company) => ({ id: company.id, name: company.name }));

  return (
    <Screen
      title="Contacts"
      actions={
        <a href="/command-center/relationships/people" className="text-[13px] font-medium underline-offset-4 hover:underline">
          Open People table
        </a>
      }
    >
      <ListToolbar
        searchPlaceholder="Search name or email"
        filters={[
          {
            key: "status",
            label: "Status",
            allLabel: "All statuses",
            options: RELATIONSHIP_STATUSES.map((value) => ({ value, label: RELATIONSHIP_STATUS_LABELS[value] })),
          },
        ]}
      />

      <DuplicatesPanel contactGroups={contactDuplicates} companyGroups={companyDuplicates} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Panel title={`${contactsPage.total} ${contactsPage.total === 1 ? "contact" : "contacts"}`}>
            <details className="mb-4">
              <summary className="cursor-pointer text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-ring">
                New contact
              </summary>
              <div className="mt-3">
                <ContactForm companies={companyOptions} />
              </div>
            </details>
            <div className="divide-y divide-border">
              {contactsPage.items.map((contact) => (
                <div key={contact.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                  <div>
                    <Link
                      href={`/command-center/relationships/contacts?id=${contact.id}`}
                      className="text-[13px] font-medium underline-offset-4 hover:underline"
                    >
                      {contact.fullName}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {contact.title || "No title recorded"}
                      {contact.currentCompanyName ? ` at ${contact.currentCompanyName}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {contact.primaryEmail || "No email recorded"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {contact.openFollowUps > 0 ? (
                      <Status>{contact.openFollowUps} open follow-up{contact.openFollowUps === 1 ? "" : "s"}</Status>
                    ) : null}
                    <Status>{RELATIONSHIP_STATUS_LABELS[contact.relationshipStatus]}</Status>
                  </div>
                </div>
              ))}
            </div>
            {!contactsPage.items.length ? (
              <NoResults
                filtered={Boolean(q || status)}
                clearHref={listHref("/command-center/relationships/contacts", query, { q: undefined, status: undefined, page: undefined })}
                emptyTitle="No contacts yet"
                emptyDescription="Imported LinkedIn connections live in the identity domain until the two records merge."
              />
            ) : null}
            <Pagination
              basePath="/command-center/relationships/contacts"
              raw={query}
              page={list.page}
              pageSize={list.pageSize}
              total={contactsPage.total}
            />
          </Panel>

          <Panel title={`${companyPageData.total} ${companyPageData.total === 1 ? "company" : "companies"}`}>
            <div className="mb-4">
              <CompanyForm />
            </div>
            <div className="divide-y divide-border">
              {companyPageData.items.map((company) => (
                <div key={company.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                  <div>
                    <p className="text-[13px] font-medium">{company.name}</p>
                    <p className="text-xs text-muted-foreground">{company.domain || "No domain recorded"}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Status>
                      {company.contactCount} current contact{company.contactCount === 1 ? "" : "s"}
                    </Status>
                    <ResearchCompanyButton companyId={company.id} />
                  </div>
                </div>
              ))}
            </div>
            {!companyPageData.items.length ? (
              <Empty title="No companies yet" />
            ) : null}
            <Pagination
              basePath="/command-center/relationships/contacts"
              raw={query}
              page={companyPage}
              pageSize={list.pageSize}
              total={companyPageData.total}
              pageParam="cpage"
            />
          </Panel>
        </div>

        <div>
          <Empty
            title="Choose a contact"
          />
        </div>
      </div>
    </Screen>
  );
}

function ContactDetailPanel({
  detail,
  companies,
  correspondence,
}: {
  detail: NonNullable<Awaited<ReturnType<typeof getContactDetail>>>;
  companies: Array<{ id: string; name: string }>;
  correspondence: Awaited<ReturnType<typeof listCorrespondence>>;
}) {
  const { contact } = detail;
  const currentCompany = detail.companies.find((company) => company.isCurrent);
  return (
    <div className="space-y-6">
      <Panel
        title={contact.fullName}
        description={`${contact.title || "No title recorded"}${currentCompany ? ` at ${currentCompany.name}` : ""}`}
      >
        <dl className="mb-4 grid gap-2 text-[13px] sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{contact.primaryEmail || "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Phone</dt>
            <dd>{contact.phone || "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Location</dt>
            <dd>{contact.location || "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{RELATIONSHIP_STATUS_LABELS[contact.relationshipStatus]}</dd>
          </div>
        </dl>
        {detail.companies.length ? (
          <div className="mb-4 space-y-1">
            {detail.companies.map((company) => (
              <p key={company.linkId} className="text-xs text-muted-foreground">
                {company.name}
                {company.title ? ` — ${company.title}` : ""}{" "}
                {company.isCurrent ? "(current)" : "(past)"}
              </p>
            ))}
          </div>
        ) : null}
        <details>
          <summary className="cursor-pointer text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-ring">
            Edit contact
          </summary>
          <div className="mt-3">
            <ContactForm
              companies={companies}
              contact={{
                id: contact.id,
                version: contact.version,
                fullName: contact.fullName,
                primaryEmail: contact.primaryEmail,
                phone: contact.phone,
                title: contact.title,
                location: contact.location,
                relationshipStatus: contact.relationshipStatus,
                notes: contact.notes,
                currentCompanyId: currentCompany?.companyId ?? null,
              }}
            />
          </div>
        </details>
        <div className="mt-4 border-t border-border pt-4">
          <ArchiveContactButton contactId={contact.id} version={contact.version} name={contact.fullName} />
        </div>
      </Panel>

      <Panel title="Follow-ups">
        <div className="mb-4 divide-y divide-border">
          {detail.followUps.map((followUp) => (
            <div key={followUp.id} className="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0">
              <div>
                <p className="text-[13px]">{followUp.note || "Follow up"}</p>
                <p className="text-xs text-muted-foreground">
                  {followUp.dueAt ? `Due ${followUp.dueAt.toISOString().slice(0, 10)}` : "No due date"}
                  {followUp.status !== "open" ? ` — ${followUp.status}` : ""}
                </p>
              </div>
              {followUp.status === "open" ? (
                <span className="flex gap-1">
                  <ResolveFollowUpButton followUpId={followUp.id} version={followUp.version} resolution="done" />
                  <ResolveFollowUpButton followUpId={followUp.id} version={followUp.version} resolution="cancelled" />
                </span>
              ) : (
                <Status>{followUp.status}</Status>
              )}
            </div>
          ))}
        </div>
        <FollowUpForm contactId={contact.id} />
      </Panel>

      <Panel
        title="Correspondence"
        description="Outreach is drafted here. You approve the exact send in Reviews, then send it from here through the connected Gmail account. Every row carries its state."
      >
        <div className="mb-4 divide-y divide-border">
          {correspondence.map((item) => (
            <div key={item.id} className="py-3 first:pt-0">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <p className="text-[13px] font-medium">{item.subject ?? "(no subject)"}</p>
                <Status>{item.state}</Status>
                <span className="text-xs text-muted-foreground">{item.channel}</span>
              </div>
              <p className="mb-2 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">{item.body}</p>
              {item.state === "drafted" || item.state === "planned" ? (
                <span className="flex flex-wrap items-center gap-2">
                  {item.proposalStatus === "approved" ? (
                    <SendApprovedButton correspondenceId={item.id} />
                  ) : item.proposalStatus === "rejected" ? (
                    <span className="text-xs text-muted-foreground">
                      Send approval was rejected. Cancel this draft and start a new one to change it.
                    </span>
                  ) : (
                    <RequestSendApprovalButton correspondenceId={item.id} version={item.version} hasProposal={!!item.actionProposalId} />
                  )}
                  <CancelCorrespondenceButton correspondenceId={item.id} version={item.version} />
                </span>
              ) : null}
            </div>
          ))}
          {!correspondence.length ? (
            <p className="py-1 text-xs text-muted-foreground">Nothing drafted yet.</p>
          ) : null}
        </div>
        <CorrespondenceForm contactId={contact.id} />
      </Panel>

      <Panel title="Observations" description="Everything asserted about this contact carries where it came from.">
        <div className="mb-4 space-y-3">
          {detail.observations.map((observation) => (
            <div key={observation.id} className="border-b border-border pb-3 last:border-0">
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{observation.body}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {observation.source} · {observation.observedAt.toISOString().slice(0, 10)}
              </p>
            </div>
          ))}
          {!detail.observations.length ? (
            <p className="text-xs text-muted-foreground">No observations recorded yet.</p>
          ) : null}
        </div>
        <ObservationForm contactId={contact.id} />
      </Panel>
    </div>
  );
}

export default function RelationshipsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading contacts…</p>}>
        <Relationships searchParams={searchParams} />
      </Suspense>
    </>
  );
}
