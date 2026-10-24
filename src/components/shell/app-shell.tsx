"use client";

import { Suspense, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PreviewStorageWarning, WorkspaceProvider } from "@/components/workspace/workspace-provider";
import { SideNav } from "@/components/shell/side-nav";
import { MobileNav } from "@/components/shell/mobile-nav";
import { TopBar } from "@/components/shell/top-bar";
import { PreviewBanner } from "@/components/shell/preview-banner";
import { isBrowserPreviewPath } from "@/lib/navigation";
import { FocusDock } from "@/components/shell/focus-dock";
import { Skeleton } from "@/components/ui/skeleton";

const subscribeToHydration = () => () => {};

/*
 * The shell is global chrome: header, the rail, the canvas, and the mobile
 * bar. Nothing here knows what a destination is.
 *
 * A client component only because the browser-preview path is derived from
 * the pathname; the layout above it stays a server component, so the auth
 * guard there is unaffected.
 *
 * The conversation is home, and home reads like a chat screen (z.ai / Linear
 * Agent): the header's breadcrumb row restates the rail's active item on the
 * one destination with no page heading of its own, so it yields its row there.
 * The composer is the page.
 */
export function AppShell({ children, storageScope = "anonymous", clerkConfigured = false }: { children: ReactNode; storageScope?: string; clerkConfigured?: boolean }) {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  // Browser-preview records live in localStorage; rendering the server's empty
  // snapshot first flashed stale rows before the stored workspace replaced them.
  const waitingForStorage = !hydrated && isBrowserPreviewPath(pathname);
  const headerless = pathname === "/alfred" || pathname.startsWith("/alfred/");

  return (
    <WorkspaceProvider key={storageScope} storageScope={storageScope}>
      <a href="#content" className="skip-link">Skip to content</a>
      <div className="flex min-h-dvh flex-1">
        <SideNav />
        <div className="flex min-w-0 flex-1 flex-col">
          {!headerless ? <TopBar clerkConfigured={clerkConfigured} /> : null}
          <main id="content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col">
            <Suspense fallback={null}><PreviewBanner /></Suspense>
            {/* Preview mutations are reachable from canonical routes, so the storage warning must be too. It renders null when empty. */}
            <PreviewStorageWarning />
            {waitingForStorage ? <PreviewSkeleton /> : null}
            {/* Still rendered while hidden so the segment stays server-rendered for instant navigation. */}
            <div hidden={waitingForStorage} className="flex min-w-0 flex-1 flex-col">{children}</div>
            <FocusDock />
          </main>
          <MobileNav />
        </div>
      </div>
    </WorkspaceProvider>
  );
}

function PreviewSkeleton() {
  return <div role="status" aria-label="Loading your browser preview" className="suite-screen">
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-full max-w-xl" /></div>
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-3 md:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
    </div>
  </div>;
}
