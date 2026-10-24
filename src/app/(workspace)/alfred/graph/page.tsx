import { Suspense } from "react";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, Screen } from "@/components/workspace/ui";
import { listCardGraph } from "@/domains/knowledge/relations";
import { getAuthContext } from "@/lib/auth";
import { GraphCanvas } from "./graph-canvas";

export const metadata = { title: "Graph · Polymath" };

/*
 * The canonical graph (ASH-167): every note and zettel as a node, explicit
 * links solid, machine suggestions dashed. Drag between two cards to tie
 * them; select two or more and combine them into one new zettel.
 */
async function GraphSurface({ searchParams }: { searchParams: Promise<{ focus?: string | string[] }> }) {
  await io();
  const auth = await getAuthContext();
  const all = await listCardGraph(auth);
  // Local graph: one card and its direct neighbours.
  const raw = (await searchParams).focus;
  const focus = typeof raw === "string" ? raw : undefined;
  const near = focus ? new Set([focus, ...all.edges.flatMap((e) => (e.source === focus ? [e.target] : e.target === focus ? [e.source] : []))]) : null;
  const nodes = near ? all.nodes.filter((n) => near.has(n.id)) : all.nodes;
  const edges = near ? all.edges.filter((e) => near.has(e.source) && near.has(e.target)) : all.edges;
  return nodes.length === 0 ? (
    <Empty title="No cards yet" />
  ) : (
    <GraphCanvas nodes={nodes} edges={edges} />
  );
}

export default function AlfredGraphPage({ searchParams }: { searchParams: Promise<{ focus?: string | string[] }> }) {
  return (
    <Screen title="Graph">
      <Suspense fallback={<Skeleton className="h-[70vh] min-h-96 rounded-xl" />}>
        <GraphSurface searchParams={searchParams} />
      </Suspense>
    </Screen>
  );
}
