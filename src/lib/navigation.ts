import type { LucideIcon } from "lucide-react";
import { products, productHref } from "@/lib/products";
import {
  Activity,
  BookOpen,
  Briefcase,
  Inbox,
  Layers,
  LayoutList,
  Library,
  NotebookPen,
  Puzzle,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareCheckBig,
  Target,
  Unplug,
  Users,
} from "lucide-react";

/*
 * The information architecture, in one place. The rail, the breadcrumb, the
 * mobile bar, and the command layer all read this list, so a destination
 * cannot exist in one and be missing from another.
 *
 * One product, one rail. The former Command Center / NeuralFlow / Alfred
 * split was a development scaffold over one system of record; the owner
 * directed (2026-10-19) that Polymath ship as a single product, so the rail
 * is one flat list of destinations and the app-switching chrome is gone.
 * URLs keep their historic prefixes; nothing else cares.
 */

export type AppSlug = "command-center" | "neuralflow" | "alfred";

export type Destination = {
  href: string;
  label: string;
  /** What the owner does here, in the owner's words — used as the page subtitle. */
  purpose: string;
  icon: LucideIcon;
  group: AppSlug | "shared";
};

/** Array order is rail order. The Polymath conversation leads because a conversation is the first move. */
export const destinations: Destination[] = [
  {
    href: "/alfred",
    label: "Polymath",
    purpose: "Start or continue a conversation.",
    icon: Sparkles,
    group: "alfred",
  },
  {
    href: "/command-center/briefing",
    label: "Today",
    purpose: "Decide what to do today.",
    icon: Target,
    group: "command-center",
  },
  {
    href: "/command-center/inbox",
    label: "Inbox",
    purpose: "Clarify what arrived.",
    icon: Inbox,
    group: "command-center",
  },
  {
    href: "/neuralflow/work",
    label: "Work",
    purpose: "Execute your commitments.",
    icon: SquareCheckBig,
    group: "neuralflow",
  },
  {
    href: "/alfred/notes",
    label: "Notes",
    purpose: "Write and keep your own pages.",
    icon: NotebookPen,
    group: "alfred",
  },
  {
    href: "/alfred/knowledge",
    label: "Document Vault",
    purpose: "Your uploaded documents, retrievable and connected.",
    icon: BookOpen,
    group: "alfred",
  },
  {
    href: "/alfred/dossiers",
    label: "Notebook",
    purpose: "Research with a bounded set of sources.",
    icon: Library,
    group: "alfred",
  },
  {
    href: "/alfred/artifacts",
    label: "Artifacts",
    purpose: "Everything the assistant made that you kept.",
    icon: Layers,
    group: "alfred",
  },
  {
    href: "/alfred/skills",
    label: "Skills",
    purpose: "Give the assistant a procedure to follow.",
    icon: Puzzle,
    group: "alfred",
  },
  {
    href: "/command-center/relationships/people",
    label: "People",
    purpose: "Everyone you know, with companies from their roles.",
    icon: Users,
    group: "command-center",
  },
  {
    href: "/command-center/relationships/companies",
    label: "Companies",
    purpose: "The organizations your people belong to.",
    icon: Briefcase,
    group: "command-center",
  },
  {
    href: "/command-center/integrations",
    label: "Connectors",
    purpose: "Wire external accounts and see what they may do.",
    icon: Unplug,
    group: "command-center",
  },
  {
    href: "/reviews",
    label: "Reviews",
    purpose: "Decide what happens next.",
    icon: ShieldCheck,
    group: "shared",
  },
  {
    href: "/activity",
    label: "Activity",
    purpose: "See what changed and why.",
    icon: Activity,
    group: "shared",
  },
  {
    href: "/settings",
    label: "Settings",
    purpose: "Configure connections, models, and policies.",
    icon: Settings,
    group: "shared",
  },
];

const featureRoutes: Record<string, string> = {
  // The notes surface moved to /alfred/notes (IA simplification); the old
  // /alfred/notebook URL stays as a redirect bridge, so the prefix resolves
  // to the Notes destination for as long as that bridge exists.
  "/alfred/notebook": "/alfred/notes",
  "/apps/command-center/briefing": "/command-center/briefing",
  "/apps/command-center/inbox": "/command-center/inbox",
  "/apps/command-center/contacts": "/command-center/relationships/people",
  "/command-center/relationships": "/command-center/relationships/people",
  "/apps/command-center/conversations": "/command-center/conversations",
  "/apps/command-center/integrations": "/command-center/integrations",
  "/apps/command-center/reviews": "/reviews",
  "/apps/command-center/activity": "/activity",
  "/apps/command-center/settings": "/settings",
  "/apps/neuralflow/tasks": "/neuralflow/work",
  "/apps/alfred/dossiers": "/alfred/dossiers",
};

export const featureDestinations: Destination[] = products.flatMap((product) =>
  product.destinations.map((destination) => ({
    href: productHref(product, destination.slug),
    label: destination.label,
    purpose: destination.description,
    icon: destination.icon,
    group: product.id,
  })),
);

/** Preview tools: reachable from More and the command layer, not the rail. */
export function additionalDestinationsIn(group: AppSlug) {
  return featureDestinations.filter((destination) => destination.group === group && !featureRoutes[destination.href]);
}

export function destinationForPath(pathname: string): Destination | undefined {
  const canonical = featureRoutes[pathname] ?? pathname;
  const exact = destinations.find((destination) => destination.href === canonical)
    ?? featureDestinations.find((destination) => destination.href === pathname);
  if (exact) return exact;
  return destinations
    .filter((destination) => canonical.startsWith(`${destination.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

export function isBrowserPreviewPath(pathname: string) {
  // The browser preview lives under /apps/ plus the shared screens still
  // rendered from the preview store. Everything under a historic prefix
  // (/command-center, /neuralflow, /alfred) and /reviews read canonical
  // records, so they never carry the preview banner (ASH-165).
  return pathname.startsWith("/apps/")
    || ["/activity", "/settings"].includes(pathname);
}

export const moreDestination = {
  href: "/more" as const,
  label: "More",
  icon: LayoutList,
};

/** Where the wordmark sends you. */
export const homeHref = "/alfred";
