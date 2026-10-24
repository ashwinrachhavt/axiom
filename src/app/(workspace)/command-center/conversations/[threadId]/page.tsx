import { io } from "next/cache";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Empty, Screen } from "@/components/workspace/ui";
import { addConversationToKnowledgeAction } from "../actions";
import { getConversation } from "@/domains/conversations/queries";
import { Button } from "@/components/ui/button";
import { getAuthContext } from "@/lib/auth";

export const metadata = { title: "Conversation · Polymath" };

/* One thread's message timeline, read from Postgres at render (ASH-140 D04).
 * Replay, cancel and checkpoints land in later slices. */

async function Timeline({ threadId }: { threadId: string }) {
  await io();
  const auth = await getAuthContext();
  const conversation = await getConversation(auth, threadId);
  if (!conversation) notFound();

  return (
    <Screen
      title={conversation.thread.title || "Untitled conversation"}
      description={`With ${conversation.thread.profileName} · started ${conversation.thread.createdAt.toISOString().slice(0, 16).replace("T", " ")}Z`}
      actions={conversation.entries.length ? (
        <form action={addConversationToKnowledgeAction}>
          <input type="hidden" name="threadId" value={threadId} />
          <Button type="submit" variant="outline" size="sm">Add to knowledge</Button>
        </form>
      ) : undefined}
    >
      <p className="text-[13px]">
        <Link href="/alfred" className="text-muted-foreground underline-offset-4 hover:underline">
          ← Conversations now live in the Assistant
        </Link>
      </p>
      <div className="space-y-4" aria-label="Timeline">
        {conversation.entries.map((entry) =>
          entry.role === "user" ? (
            <div key={entry.id} className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-[13px] leading-6">
              {entry.content ?? ""}
            </div>
          ) : (
            <div key={entry.id} className="max-w-[72ch]">
              <p className="whitespace-pre-wrap text-[13px] leading-6">{entry.content ?? ""}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {entry.role} · {entry.createdAt.toISOString().slice(0, 16).replace("T", " ")}Z
              </p>
            </div>
          ),
        )}
        {!conversation.entries.length ? (
          <Empty title="No messages yet" />
        ) : null}
      </div>
    </Screen>
  );
}

export default async function ConversationPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading conversation…</p>}>
      <Timeline threadId={threadId} />
    </Suspense>
  );
}
