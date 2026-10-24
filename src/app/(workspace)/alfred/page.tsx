import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { io } from "next/cache";
import { redirect } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { getAuthContext } from "@/lib/auth";
import { isWorkspaceOnboarded } from "@/domains/agents/onboarding";
import { listRecentRuns } from "@/domains/agents/queries";
import { listSkills } from "@/domains/skills/queries";
import { timeAgo, timeAgoShort } from "@/lib/time";
import { groupByRecency } from "@/lib/history-groups";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { NewConversation } from "./new-conversation";
import { listConversations } from "@/domains/conversations/queries";
import { HistoryMenu } from "./history-menu";
import { ModelPicker } from "./model-picker";
import type { PickableSkill } from "./skills/slash-skill-menu";
import { getProfileModelPolicy } from "@/domains/agents/queries";
import { availableModels, resolveModelId } from "@/domains/agents/models";

export const metadata = { title: "Polymath" };

/*
 * Polymath is home: one composer, then the conversations that already exist.
 * The rail names the destination, so the page opens with the question
 * rather than a title restating it (agents/design.md: no oversized H1s, the
 * greeting is the whole of the header here).
 *
 * A fresh workspace shows the greeting and the composer and nothing else. An
 * empty "Recent" block would be chrome promising history the person has not
 * written yet; the composer is already the invitation.
 */

export async function AlfredSurface() {
  // Per-request data: auth resolution upserts identity and stamps now().
  await io();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <Home>
        <div className="mx-auto w-full max-w-2xl">
          <EmptyState
            title="Agent storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to view runs. Agent execution also needs an Eve runtime and model credentials (EVE_BASE_URL and OPENAI_API_KEY). Set EVE_BRIDGE_SECRET (32+ characters, shared with the Eve agent) to sign runs to Eve."
          />
        </div>
      </Home>
    );
  }

  const auth = await getAuthContext();
  // First run goes to the interview: the workspace's supervisor agent is the
  // person's own representation, shaped by what onboarding learns. A workspace
  // that skipped it meets a placeholder agent, so the gate sends it there once.
  if (!(await isWorkspaceOnboarded(auth.workspaceId))) {
    redirect("/onboarding");
  }
  // The history reads and the model policy are independent: issue them together
  // so the page costs one round trip per query rather than one per query in
  // sequence.
  const [runs, conversationThreads, skillRows, modelPolicy] = await Promise.all([
    // One query feeds both views: the menu is the history, so it needs more than
    // the five rows shown under the composer. Fifty is a bounded read, not the
    // whole table, so the page stays cheap as history grows.
    listRecentRuns(auth.workspaceId, 50),
    // Conversation threads (the retired Conversations surface) stay discoverable
    // inside the chat history control: same query bound as the run history, and
    // the thread pages themselves are untouched so every old link keeps working.
    listConversations(auth),
    // Only enabled skills can be pinned; the engine refuses anything else.
    listSkills(auth, { enabled: true }),
    getProfileModelPolicy(auth.workspaceId, "alfred"),
  ]);
  // The dropdown is the complete history; the list under the composer is the
  // five most recent. One array, two views.
  const recent = runs.slice(0, 5);
  const skills: PickableSkill[] = skillRows.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
  }));
  const unavailable = eveBridgeUnavailableReason();
  // Only models whose provider key is present: offering one that cannot run
  // would freeze a model into a run that then fails on its first step.
  const models = availableModels();
  const stored = (modelPolicy as { primary?: unknown } | null)?.primary;
  const currentModel = resolveModelId(stored);

  return (
    <Home>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-2">
        {runs.length > 0 || conversationThreads.length > 0 ? (
          <div className="flex">
            <HistoryMenu
              groups={[
                ...groupByRecency(runs).map((group) => ({
                  key: group.key,
                  label: group.label,
                  rows: group.rows.map((run) => ({
                    id: run.id,
                    objective: run.objective,
                    time: timeAgoShort(run.createdAt),
                  })),
                })),
                ...(conversationThreads.length > 0
                  ? [
                      {
                        key: "threads",
                        label: "Threads",
                        rows: conversationThreads.map((thread) => ({
                          id: thread.id,
                          objective: thread.title || "Untitled conversation",
                          time: timeAgoShort(thread.lastMessageAt ?? thread.updatedAt),
                          href: `/command-center/conversations/${thread.id}`,
                        })),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        ) : null}
        <NewConversation skills={skills} />
        <ModelPicker models={models} current={currentModel} />
        {unavailable ? (
          <p role="status" className="text-muted-foreground text-[12px]">
            {unavailable}
          </p>
        ) : null}
      </div>

      {recent.length > 0 ? (
        <section className="mx-auto flex w-full max-w-2xl flex-col gap-2">
          <ul className="divide-border flex flex-col divide-y border-t">
            {recent.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/alfred/${run.id}`}
                  className="hover:bg-muted/50 flex items-center gap-3 py-2.5 text-[13px]"
                >
                  <span className="min-w-0 flex-1 truncate">{run.objective}</span>
                  <span className="text-muted-foreground shrink-0 text-[11px]">
                    {timeAgo(run.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Home>
  );
}

/** The one frame both the configured and unconfigured states share. */
function Home({ children }: { children: ReactNode }) {
  return (
    <div className="page-content flex flex-1 flex-col gap-10 pt-16">
      <h1 className="text-center text-2xl font-medium">What would you like to work on?</h1>
      {children}
    </div>
  );
}

export default function AlfredPage() {
  return (
    <Suspense fallback={<AlfredSkeleton />}>
      <AlfredSurface />
    </Suspense>
  );
}

function AlfredSkeleton() {
  return (
    <div role="status" aria-label="Loading Polymath" className="page-content flex flex-1 flex-col gap-10 pt-16">
      <Skeleton className="mx-auto h-7 w-80 max-w-full" />
      <Skeleton className="mx-auto h-24 w-full max-w-2xl" />
    </div>
  );
}
