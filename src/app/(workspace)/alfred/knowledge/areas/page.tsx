import Link from "next/link";
import { io } from "next/cache";
import { listAreas } from "@/domains/knowledge/area-queries";
import { getAuthContext } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { Empty, Panel, Status } from "@/components/workspace/ui";
import { AreaActions, NewAreaForm } from "./area-controls";

/*
 * "Am I getting better at this?" per declared area. Effort (notes, manual
 * links, recall activity) and knowledge confidence (recall accuracy,
 * accepted-claim share) sit side by side as raw counts and ratios; nothing
 * is averaged into a single score and nothing claims expertise. Where
 * effort is high and confidence is low the page says so plainly - study,
 * don't just reread. Focus time is intentionally absent: sessions join to
 * tasks, not artifacts, so there is no honest per-area focus number yet.
 */

function ratio(hit: number, total: number): string {
  if (total === 0) return "no evidence yet";
  return `${hit}/${total} (${Math.round((hit / total) * 100)}%)`;
}

export default async function AreasPage() {
  await io();
  const auth = await getAuthContext();
  const areas = await listAreas(auth);

  return (
    <>
      <PageHeader title="Areas" purpose="Am I getting better at this?" />

      <nav aria-label="Knowledge views" className="flex gap-1 border-b border-border">
        <Link href="/alfred/knowledge" className="px-3 py-1.5 text-[13px] text-muted-foreground underline-offset-2 hover:underline">
          Documents
        </Link>
        <Link href="/alfred/knowledge/zettels" className="px-3 py-1.5 text-[13px] text-muted-foreground underline-offset-2 hover:underline">
          Zettels
        </Link>
        <Link href="/alfred/knowledge/cards" className="px-3 py-1.5 text-[13px] text-muted-foreground underline-offset-2 hover:underline">
          Cards
        </Link>
        <span aria-current="page" className="border-b-2 border-foreground px-3 py-1.5 text-[13px] font-medium">
          Areas
        </span>
      </nav>

      <div className="page-content flex flex-col gap-6">
        <Panel title="Declare an area" description="A name and the note tags it covers. Nothing is inferred.">
          <NewAreaForm />
        </Panel>

        <Panel>
          {areas.length === 0 ? (
            <Empty
              title="No areas yet"
              description="Declare a topic you want to get better at - distributed systems, a language, a field - and this page starts measuring effort and confidence separately."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {areas.map((area) => (
                <li key={area.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[13px] font-medium">{area.name}</p>
                      <span className="text-xs text-muted-foreground">{area.tags.join(", ")}</span>
                    </div>
                    <Status>{area.state}</Status>
                  </div>
                  {/* Side by side, never averaged. */}
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Effort</span> - {area.effort.notes}{" "}
                      {area.effort.notes === 1 ? "note" : "notes"}, {area.effort.manualLinks} manual{" "}
                      {area.effort.manualLinks === 1 ? "link" : "links"}, {area.effort.recallAttempts}{" "}
                      {area.effort.recallAttempts === 1 ? "review" : "reviews"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Confidence</span> - recalled{" "}
                      {ratio(area.confidence.recallCorrect, area.confidence.recallTotal)}; typed attempts{" "}
                      {ratio(area.confidence.typedAttempts, area.confidence.recallTotal)}; claims accepted{" "}
                      {ratio(area.confidence.claimsAccepted, area.confidence.claimsDecided)}
                    </div>
                  </div>
                  {area.suggestStudy && (
                    <p className="text-xs">
                      Effort is high and recall is low - study this, don&apos;t just reread it.
                    </p>
                  )}
                  <AreaActions areaId={area.id} expectedVersion={area.version} name={area.name} tags={area.tags} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
