"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { destinationForPath, destinations, moreDestination } from "@/lib/navigation";
import { cn } from "cn";

/*
 * The phone bottom bar: Polymath, Today, Work, Notebook, and More — the
 * destinations a thumb reaches for most — with the full list behind More.
 * Wired by href, not label, because /alfred/dossiers is the Notebook
 * destination while the rail's Notes destination lives at /alfred/notes.
 * Target size is 44px, above the 24px floor in agents/design.md, because a
 * thumb is not a cursor.
 */
const barHrefs = ["/alfred", "/command-center/briefing", "/neuralflow/work", "/alfred/dossiers"];

export function MobileNav() {
  const pathname = usePathname();
  const activeHref = destinationForPath(pathname)?.href;
  const items = [
    ...destinations.filter((d) => barHrefs.includes(d.href)),
    moreDestination,
  ];

  return (
    <nav
      aria-label="Destinations"
      className="border-border bg-background sticky bottom-0 z-20 flex shrink-0 border-t pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {items.map(({ href, label, icon: Icon }) => {
        const active = "href" in moreDestination && href === moreDestination.href ? pathname === href : activeHref === href;
        return (
          <Link
            key={href}
            href={href}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] outline-none",
              "focus-visible:ring-ring focus-visible:ring-3",
              active ? "text-app-accent font-medium" : "text-muted-foreground",
            )}
          >
            <Icon aria-hidden className="size-4" />
            <span className="truncate px-1">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
