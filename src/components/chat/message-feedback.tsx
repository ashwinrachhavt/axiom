"use client";

import { useState, useTransition } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "cn";

/*
 * Like/dislike under one assistant message. The verdict is a toggle: the same
 * button again clears it. It lands on the run_event the message was written
 * to (POST /api/v1/runs/:runId/feedback), so evaluation can filter on a
 * column, not on re-parsed JSONB. A stored transcript addresses the event by
 * sequence; a live stream only knows the blockId's turn id.
 */
export function MessageFeedback({
  runId,
  sequence,
  turnId,
  initial,
}: {
  runId: string;
  sequence?: number;
  turnId?: string;
  initial: "up" | "down" | null;
}) {
  const [value, setValue] = useState<"up" | "down" | null>(initial);
  const [error, setError] = useState(false);
  const [, startTransition] = useTransition();

  function send(next: "up" | "down" | "clear") {
    setError(false);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/v1/runs/${encodeURIComponent(runId)}/feedback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sequence, turnId, feedback: next }),
        });
        if (!response.ok) {
          setError(true);
          return;
        }
        setValue(next === "clear" ? null : next);
      } catch {
        setError(true);
      }
    });
  }

  return (
    <div className="mt-1 flex items-center gap-0.5">
      <button
        type="button"
        aria-label="Helpful"
        aria-pressed={value === "up"}
        title="Helpful"
        onClick={() => send(value === "up" ? "clear" : "up")}
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          value === "up" && "text-foreground bg-muted",
        )}
      >
        <ThumbsUp aria-hidden className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Not helpful"
        aria-pressed={value === "down"}
        title="Not helpful"
        onClick={() => send(value === "down" ? "clear" : "down")}
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          value === "down" && "text-foreground bg-muted",
        )}
      >
        <ThumbsDown aria-hidden className="size-3.5" />
      </button>
      {error ? (
        <span className="text-destructive ml-1.5 text-[11px]" role="alert">
          Feedback was not saved.
        </span>
      ) : null}
    </div>
  );
}
