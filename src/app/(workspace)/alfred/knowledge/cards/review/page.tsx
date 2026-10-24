import Link from "next/link";
import { Suspense } from "react";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, Panel, Screen } from "@/components/workspace/ui";
import { countDueCards, nextDueCard } from "@/domains/knowledge/card-queries";
import { getAuthContext } from "@/lib/auth";
import { ReviewCard } from "./review-card";

export const metadata = { title: "Review · Polymath" };

/*
 * The recall sitting: the oldest due card, answer hidden until attempted.
 * The server owns the queue - a refresh mid-sitting resumes the same card,
 * and grading one hands the next.
 */

async function ReviewSurface() {
  await io();
  const auth = await getAuthContext();
  const [card, dueCount] = await Promise.all([nextDueCard(auth), countDueCards(auth)]);

  return (
    <Screen
      title="Review"
      actions={
        <Link href="/alfred/knowledge/cards" className="text-[13px] text-muted-foreground underline-offset-2 hover:underline">
          Back to Cards
        </Link>
      }
    >
      <Panel>
        {card ? (
          <ReviewCard key={card.id} card={card} dueCount={dueCount} />
        ) : (
          <Empty title="No cards due" />
        )}
      </Panel>
    </Screen>
  );
}

export default function ReviewPage() {
  return (
    <Suspense
      fallback={
        <div role="status" aria-label="Loading Review" className="flex flex-1 flex-col gap-4 p-6">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24 w-full max-w-xl" />
        </div>
      }
    >
      <ReviewSurface />
    </Suspense>
  );
}
