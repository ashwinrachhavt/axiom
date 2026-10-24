import Link from "next/link";
import { io } from "next/cache";
import { Screen } from "@/components/workspace/ui";
import { getAuthContext } from "@/lib/auth";
import { listEventsBetween } from "@/domains/calendar/queries";
import { getPreferences } from "@/domains/identity/preferences";
import { dateFromKey, shiftDateKey, todayKeyInTimezone, weekStartKeyOf } from "@/lib/local-date";
import { listTasksDueBetweenForPage } from "./data";
import { listPendingCalendarProposals } from "@/domains/calendar/proposals";
import { CalendarToolbar } from "./calendar-assist";
import { WeekGrid } from "./week-grid";

/*
 * The Work calendar on Neon: saved tasks laid out by due date, one week at a
 * time. "Today" and the week window compare in the user's saved timezone, so
 * the week does not roll over during the user's evening; date-only due dates
 * are stored on the noon-UTC pin, which names the same local day. The week
 * starts on the user's saved week-start preference. Provider events and local
 * time blocks are the preview calendar's business; this screen answers one
 * question: what saved work is due when.
 */

const DAY = 86_400_000;

export async function NeonCalendar({ date }: { date?: string }) {
  await io();
  const auth = await getAuthContext();
  const { timezone, weekStart } = await getPreferences(auth);
  const today = todayKeyInTimezone(timezone);
  const anchor = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
  const startKey = weekStartKeyOf(anchor, weekStart);
  const endKey = shiftDateKey(startKey, 6);
  const start = dateFromKey(startKey);
  const rows = await listTasksDueBetweenForPage(auth, startKey, endKey);
  // Pad a day each side so blocks near midnight survive any browser zone.
  const events = await listEventsBetween(auth, new Date(start.getTime() - DAY), new Date(start.getTime() + 8 * DAY));
  const proposals = await listPendingCalendarProposals(auth);
  const blocked = new Set(events.map((e) => e.taskId).filter(Boolean));
  const unscheduled = rows
    .filter((r) => r.status !== "done" && r.status !== "cancelled" && !blocked.has(r.id))
    .map((r) => ({ id: r.id, title: r.title, estimateMinutes: r.estimateMinutes, done: false }));
  const base = "/neuralflow/work?view=calendar";

  return (
    <Screen
      title="Week"
    >
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Link className="rounded-md border border-border px-2.5 py-1 hover:bg-accent" href={`${base}&date=${shiftDateKey(startKey, -7)}`}>
          Previous week
        </Link>
        <Link className="rounded-md border border-border px-2.5 py-1 hover:bg-accent" href={base}>
          This week
        </Link>
        <Link className="rounded-md border border-border px-2.5 py-1 hover:bg-accent" href={`${base}&date=${shiftDateKey(startKey, 7)}`}>
          Next week
        </Link>
        <span className="readout text-xs text-muted-foreground">
          {startKey} to {endKey}
        </span>
        {/* Planning tools belong to the calendar, not the tab row. */}
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/scheduler">Scheduler</Link>
          <Link className="py-1 hover:text-foreground hover:underline" href="/apps/neuralflow/meetings">Meetings</Link>
        </span>
      </div>
      <CalendarToolbar
        events={events.map((e) => ({ title: e.title, startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString(), taskId: e.taskId }))}
        proposals={proposals}
      />
      <WeekGrid
        weekStartMs={start.getTime()}
        events={events.map((e) => ({
          id: e.id,
          title: e.title,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt.toISOString(),
          version: e.version,
          taskId: e.taskId,
        }))}
        unscheduled={unscheduled}
      />
    </Screen>
  );
}
