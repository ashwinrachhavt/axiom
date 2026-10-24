"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsLeft, ChevronsRight, Search } from "lucide-react";
import { cn } from "cn";
import {
  destinationForPath,
  destinations,
  homeHref,
  type Destination,
} from "@/lib/navigation";

/*
 * The shell's left rail: the Polymath wordmark, then one flat list of the
 * product's destinations. There is no app layer to switch between, so no
 * identity header per app and no launcher entry — everything on screen is
 * Polymath. Shared workspace services (Reviews, Activity, Settings) sit at
 * the bottom. Collapses to an icon rail; the choice persists in localStorage.
 *
 * No count badges: the only counts chrome can read without a server
 * round-trip come from the browser-preview store, and the rail's pages read
 * canonical Postgres records - a badge from one source over a page fed by
 * another is a number that lies (ASH-164).
 */

const COLLAPSED_KEY = "axiom-sidenav-collapsed";
const subscribeToHydration = () => () => {};

export function SideNav() {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (window.localStorage.getItem(COLLAPSED_KEY) !== "1") return;
    const frame = requestAnimationFrame(() => setCollapsed(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  function toggle() {
    setCollapsed((current) => {
      window.localStorage.setItem(COLLAPSED_KEY, current ? "0" : "1");
      return !current;
    });
  }

  function openCommand() {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  }

  const activeHref = destinationForPath(pathname)?.href;

  function itemLink(destination: Destination) {
    const active = activeHref === destination.href;
    return (
      <Link
        key={destination.href}
        href={destination.href}
        aria-label={destination.label}
        title={collapsed ? destination.label : undefined}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-8 min-h-8 items-center gap-2.5 rounded-md text-[13px] transition-colors outline-none",
          "focus-visible:ring-ring focus-visible:ring-3",
          collapsed ? "justify-center px-0" : "px-2.5",
          active
            ? "bg-sidebar-accent text-sidebar-foreground font-medium"
            : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
        )}
      >
        <destination.icon aria-hidden className={cn("size-4 shrink-0", !active && "opacity-75")} />
        {collapsed ? null : <span className="min-w-0 flex-1 truncate">{destination.label}</span>}
      </Link>
    );
  }

  return (
    <nav
      aria-label="Workspace"
      className={cn(
        "group/nav border-sidebar-border bg-sidebar sticky top-0 hidden h-dvh shrink-0 border-r md:block",
        collapsed ? "w-[52px]" : "w-60",
      )}
    >
      <div className="flex h-full flex-col gap-1 overflow-y-auto px-2 py-2.5">
        {/*
         * The mark and the disclosure share one row in both states, so the
         * chevron sits where the eye already is. A 52px rail cannot hold a 24px
         * mark and a 24px target inside the 8px gutter, so the collapsed row
         * borrows the gutter back rather than shrinking the target below the
         * 24px floor in agents/design.md.
         */}
        <div className={cn("flex items-center", collapsed ? "-mx-1.5" : "gap-1")}>
          {/* axe's label-content-name-mismatch: when an aria-label is present,
              the link's text content must appear inside it. The mark's "P" is
              aria-hidden for painting but still counts as text content here, so
              any aria-label ("Polymath", "Polymath home") fails the rule. No
              label: the visible "Polymath" names the link, and the title covers
              the collapsed state where the text is not rendered. */}
          <Link
            href={homeHref}
            title={collapsed ? "Polymath" : undefined}
            className={cn(
              "text-sidebar-foreground hover:bg-sidebar-accent flex items-center gap-2 rounded-md text-[13px] font-semibold tracking-tight transition-colors outline-none",
              "focus-visible:ring-ring focus-visible:ring-3",
              collapsed ? "size-6 justify-center px-0" : "h-9 min-w-0 flex-1 px-2",
            )}
          >
            <span aria-hidden className="polymath-mark !size-6 !text-[15px]">P</span>
            {collapsed ? null : <span className="min-w-0 flex-1 truncate text-left">Polymath</span>}
          </Link>
          {/*
           * aria-expanded reports the rail, the label reports the action: a
           * name that restates the current state ("Collapsed") tells a screen
           * reader where it is, not what pressing the button does.
           *
           * Invisible until hover: the collapse control is chrome, not content,
           * so it stays out of the rail's reading order until the pointer is
           * over the rail. Keyboard focus and the expanded state keep it
           * visible (focus-visible for keyboard, aria-expanded for the state);
           * on touch there is no hover, so the expanded rail keeps its opacity
           * and the collapsed rail shows the expand arrow outright.
           */}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            title={collapsed ? "Expand navigation" : "Collapse navigation"}
            className={cn(
              "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground flex shrink-0 items-center justify-center rounded-md transition-colors outline-none",
              "focus-visible:ring-ring focus-visible:ring-3",
              "opacity-0 group-hover/nav:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100",
              collapsed ? "size-6" : "size-8",
            )}
          >
            {collapsed ? (
              <ChevronsRight aria-hidden className="size-4" />
            ) : (
              <ChevronsLeft aria-hidden className="size-4" />
            )}
          </button>
        </div>

        <span className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={openCommand}
          disabled={!hydrated}
          aria-label="Search workspace"
          data-search-trigger
          aria-keyshortcuts="Meta+K Control+K"
          className={cn(
            "border-sidebar-border bg-card text-muted-foreground hover:text-foreground disabled:opacity-50 flex h-8 flex-1 items-center gap-2.5 rounded-md border text-[13px] transition-colors outline-none",
            "focus-visible:ring-ring focus-visible:ring-3",
            collapsed ? "justify-center border-transparent bg-transparent px-0 hover:bg-sidebar-accent" : "px-2.5",
          )}
        >
          <Search aria-hidden className="size-4 shrink-0" />
          {collapsed ? null : (
            <>
              <span className="flex-1 text-left">Search</span>
            </>
          )}
        </button>
        {collapsed ? null : <kbd aria-hidden className="readout text-[11px]">⌘K</kbd>}
        </span>

        {/* The product's destinations, one list. Default prefetch: with
            partialPrefetching each destination's App Shell is fetched once and
            shared. prefetch={true} would add a per-link server render for URL
            data none of these rail links carry. */}
        <div className="mt-2 flex flex-1 flex-col gap-px">
          <div className="flex flex-col gap-px">{destinations.filter((d) => d.group !== "shared").map(itemLink)}</div>
        </div>

        {/* Shared workspace services, at the foot. */}
        <div className="mt-auto flex flex-col gap-0.5 pt-2">
          <div aria-hidden className="border-sidebar-border mx-2 mb-1 border-t" />
          <div className="flex flex-col gap-px">{destinations.filter((d) => d.group === "shared").map(itemLink)}</div>
        </div>
      </div>
    </nav>
  );
}
