"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

const CandidateFacts = dynamic(() => import("./candidate-facts"), { loading: () => <p role="status">Loading candidate fact controls…</p> });
const ApiKeysPanel = dynamic(() => import("./api-keys-panel"), { loading: () => <p role="status">Loading API keys…</p> });
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, Panel, Screen, Status, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { Check, Destination, DisabledAction, Select } from "./controls";
import { loadAssistantProfileAction, loadPreferencesAction, saveAssistantProfileAction, savePreferencesAction } from "@/app/(workspace)/settings/actions";
import type { LoadedPreferences } from "@/domains/identity/preferences";
import type { CapabilityStatus } from "@/lib/capability-config";
import { SchedulerPanel } from "./scheduler-panel";

/*
 * One settings surface for all three products. Timezone, week start,
 * appearance and motion are server rows (D23): they save to the account and
 * load on every device. Anything this browser still owns is named as
 * preview-local, and anything it cannot do is named as unavailable with the
 * reason, rather than shown as a control that pretends to save.
 *
 * Layout follows the Loan Labs settings reference the owner sent: a grouped
 * sub-nav on the left, one quiet column of sections on the right. The sub-nav
 * collapses to a horizontal scroll row under md, and the active row tracks
 * scroll position through an IntersectionObserver.
 */

const SECTION_GROUPS = [
  {
    label: "Preferences",
    items: [
      { id: "planning", label: "Planning" },
      { id: "scheduling", label: "Scheduling" },
      { id: "accessibility", label: "Accessibility" },
      { id: "appearance", label: "Appearance" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "assistant", label: "Your assistant" },
      { id: "execution-safety", label: "Execution safety" },
      { id: "model-policy", label: "Model and tools" },
      { id: "connectors", label: "Connectors" },
      { id: "documents", label: "Documents" },
      { id: "account", label: "Account and clients" },
    ],
  },
  {
    label: "Data",
    items: [
      { id: "data-retention", label: "Data and retention" },
      { id: "candidate-facts", label: "Candidate facts" },
      { id: "reset", label: "Reset preview" },
    ],
  },
] as const;

const SECTION_IDS = SECTION_GROUPS.flatMap((group) => group.items.map((item) => item.id));

function useActiveSection() {
  const [active, setActive] = useState<string>(SECTION_IDS[0]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-15% 0px -75% 0px" },
    );
    for (const id of SECTION_IDS) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  return active;
}

/*
 * Settings section nav, on the cal.com settings-shell pattern
 * (VerticalTabs + horizontal collapse): grouped links in a sticky w-56
 * column from lg, a scrollable tab strip below it with the active tab
 * scrolled into view. Plain anchors with aria-current; no tab component
 * dependency, because sections scroll in place instead of routing.
 */
function SettingsNav({ groups, active }: { groups: readonly [{ readonly label: string; readonly items: readonly { readonly id: string; readonly label: string }[] }, ...{ readonly label: string; readonly items: readonly { readonly id: string; readonly label: string }[] }[]]; active: string }) {
  const stripRef = useRef<HTMLElement | null>(null);
  const lastScrolledRef = useRef<string | null>(null);
  const currentItem = groups.flatMap((group) => group.items).find((item) => item.id === active);
  useEffect(() => {
    const nav = stripRef.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    if (lastScrolledRef.current === active) return;
    const activeElement = nav.querySelector<HTMLElement>("[aria-current='true']");
    if (!activeElement) return;
    activeElement.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
    lastScrolledRef.current = active;
  }, [active]);
  return (
    <>
      <nav aria-label="Settings sections" className="no-scrollbar hidden w-56 shrink-0 flex-col gap-1 lg:sticky lg:top-16 lg:flex lg:h-fit lg:overflow-y-auto">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="px-2 pt-4 pb-1 text-[11px] font-medium text-muted-foreground first:pt-0">{group.label}</p>
            {group.items.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                aria-current={active === item.id ? "true" : undefined}
                className="flex min-h-8 w-full items-center rounded-md px-2 py-1.5 text-[13px] font-medium text-foreground transition hover:bg-muted [&[aria-current='true']]:bg-muted [&[aria-current='true']]:text-foreground"
              >
                {item.label}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <nav aria-label="Settings sections" ref={stripRef} className="no-scrollbar flex gap-0.5 overflow-x-auto rounded-md lg:hidden">
        {groups.flatMap((group) => group.items).map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            aria-current={active === item.id ? "true" : undefined}
            className="flex min-h-8 shrink-0 items-center whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition hover:bg-muted hover:text-foreground [&[aria-current='true']]:bg-muted [&[aria-current='true']]:font-medium [&[aria-current='true']]:text-foreground"
          >
            {item.label}
          </a>
        ))}
      </nav>
      <p className="sr-only" aria-live="polite">{currentItem ? `${currentItem.label} section` : ""}</p>
    </>
  );
}

function Section({ id, children }: { id: string; children: React.ReactNode }) {
  return <div id={id} className="scroll-mt-6">{children}</div>;
}

/*
 * Which integrations this deployment can actually run, named. A missing key used
 * to render as an empty list that looked like "nothing to show" — this panel is
 * the difference between "no results" and "not switched on" (ASH-193). Variable
 * names only; a value never reaches the browser.
 */
function CapabilityPanel({ capabilities }: { capabilities?: CapabilityStatus[] }) {
  if (!capabilities || capabilities.length === 0) return null;
  const missing = capabilities.filter((c) => !c.configured);
  const ready = capabilities.filter((c) => c.configured);
  return (
    <Panel title="Configured capabilities" description="What this deployment can run right now, read from its environment. Names only — never values.">
      {missing.length > 0 ? <div className="flex flex-col gap-3">{missing.map((c) => <Unavailable key={c.id} feature={c.label}>{c.reason} <span className="readout mt-1 block text-xs">{c.missingEnv.join(", ")}</span></Unavailable>)}</div> : null}
      {ready.length > 0 ? <div className="mt-4 flex flex-wrap gap-2">{ready.map((c) => <Status key={c.id}>{c.label} ready</Status>)}</div> : null}
      {missing.length === 0 ? <p className="mt-3 text-[13px] text-muted-foreground">Every integration this release claims is configured.</p> : <p className="mt-3 text-[13px] text-muted-foreground">{missing.length} of {capabilities.length} are not configured. Each one is listed above with the variable that turns it on.</p>}
    </Panel>
  );
}

export type AssistantProfile = { name: string; description: string | null; instructions: string | null; version: number };

/*
 * The assistant's learned brief (spec "It learns your taste"): what onboarding
 * wrote, open to review and change. Saving empty retires that part of the
 * brief for future runs; the onboarding interview and the change history are
 * kept - retiring is not erasing. The profile's name is the machine key runs
 * resolve by, so it is shown, not edited.
 *
 * The draft is controlled state, so a conflict can keep the person's unsaved
 * edits on screen while showing what the server has now: re-saving targets
 * the latest version, and "Replace my edits" adopts the server's values.
 */
export function AssistantPanel({ profile }: { profile: AssistantProfile }) {
  const { notify } = useWorkspace();
  const [saved, setSaved] = useState(profile);
  const [draft, setDraft] = useState({ description: profile.description ?? "", instructions: profile.instructions ?? "" });
  const [conflict, setConflict] = useState<AssistantProfile | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <Panel title="Your assistant" description={`What your assistant knows about how you work, learned during onboarding (profile: ${saved.name}). Edit to correct it; save empty fields to retire them for future runs. Retiring is not erasing: the onboarding interview and the change history are kept.`}>
      <form className="grid gap-4" onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        void saveAssistantProfileAction({ description: draft.description, instructions: draft.instructions, expectedVersion: saved.version }).then((result) => {
          setSaving(false);
          if (!result.ok) {
            if (result.kind === "conflict") {
              // Keep the draft; show what changed underneath it.
              void loadAssistantProfileAction().then((loaded) => { if (loaded.ok && loaded.profile) { setSaved(loaded.profile); setConflict(loaded.profile); } });
              notify("The brief changed elsewhere. Your edits are kept below - review what changed, then save again or replace them.");
            } else {
              notify(result.error);
            }
            return;
          }
          setSaved(result.profile);
          setDraft({ description: result.profile.description ?? "", instructions: result.profile.instructions ?? "" });
          setConflict(null);
          notify("Assistant brief saved. It guides every future run.");
        });
      }}>
        {conflict ? (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-[13px]">
            <p className="font-medium">Changed elsewhere while you edited.</p>
            <p className="mt-1 text-muted-foreground">Latest description: {conflict.description ?? "(retired)"}</p>
            <p className="mt-0.5 line-clamp-2 text-muted-foreground">Latest brief: {conflict.instructions ?? "(retired)"}</p>
            <Button type="button" variant="outline" className="mt-2" onClick={() => { setDraft({ description: conflict.description ?? "", instructions: conflict.instructions ?? "" }); setConflict(null); }}>Replace my edits with the latest</Button>
          </div>
        ) : null}
        <Field label="Description - one line on what it is to you"><Textarea name="description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={500} rows={2} placeholder="Retired - nothing saved." /></Field>
        <Field label="Learned brief - how it should write, explain and work with you"><Textarea name="instructions" value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} maxLength={4000} rows={6} placeholder="Retired - nothing saved." /></Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="outline" disabled={saving}>{saving ? "Saving…" : conflict ? "Save over the latest" : "Save assistant brief"}</Button>
          <p className="text-xs text-muted-foreground">Changes apply to future runs; running work keeps the brief it started with.</p>
        </div>
      </form>
    </Panel>
  );
}

export default function Settings({ serverPreferences, capabilities, serverAssistantProfile, browserPreview }: { serverPreferences?: LoadedPreferences; capabilities?: CapabilityStatus[]; serverAssistantProfile?: AssistantProfile | null; browserPreview: boolean }) {
  const { state, updatePreferences, resetPreview, notify } = useWorkspace();
  // The server row is the record; `saved` mirrors it here so a form always
  // submits against the version it rendered (compare-and-set on the server).
  // The /settings route passes the row in; the legacy /apps dispatch is
  // client-rendered, so it loads the same row on mount instead.
  const [saved, setSaved] = useState(serverPreferences ?? { timezone: "UTC", weekStart: 1, appearance: "system", motion: "full", version: 0 });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (serverPreferences) return;
    void loadPreferencesAction().then((result) => { if (result.ok) setSaved(result.preferences); });
  }, [serverPreferences]);
  const [resetOpen, setResetOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [factsOpen, setFactsOpen] = useState(false);
  const active = useActiveSection();
  return <Screen title="Settings" description={browserPreview
    ? "This browser preview keeps its own local state; nothing here is an account. The panels below describe what the preview stores or name what is not built yet."
    : "Timezone, week start, appearance and motion save to your account and load on every device. The remaining panels name this deployment's capabilities and what is not built yet."} actions={<Destination screen="integrations">Connection catalog</Destination>}>
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
      <SettingsNav groups={SECTION_GROUPS} active={active} />


      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <Section id="planning">
          <Panel title="Planning preferences">
            <form key={`${saved.timezone}-${saved.weekStart}`} className="grid gap-4" onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              const timezone = String(data.get("timezone")).trim();
              try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date()); } catch { notify("Timezone is not recognized. Enter an IANA timezone such as America/Los_Angeles."); return; }
              const weekStart = String(data.get("weekStart")) === "Sunday" ? 7 : 1;
              setSaving(true);
              void savePreferencesAction({ expectedVersion: saved.version, timezone, weekStart }).then((result) => {
                setSaving(false);
                if (!result.ok) { notify(result.error); return; }
                setSaved(result.preferences);
                // The preview store follows the account record so the local
                // screens that still read it stay consistent.
                updatePreferences({ timezone: result.preferences.timezone, weekStart: result.preferences.weekStart === 7 ? "Sunday" : "Monday" });
                notify("Planning preferences saved to your account. They load on every device and product.");
              });
            }}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Timezone (IANA identifier)"><Input required name="timezone" defaultValue={saved.timezone} list="cc-timezones"/><datalist id="cc-timezones">{["UTC", "America/Los_Angeles", "America/New_York", "Europe/London", "Asia/Kolkata", "Asia/Tokyo"].map((timezone) => <option key={timezone} value={timezone}/>)}</datalist></Field>
                <Field label="Week starts on"><Select name="weekStart" defaultValue={saved.weekStart === 7 ? "Sunday" : "Monday"}><option>Monday</option><option>Sunday</option></Select></Field>
              </div>
              <Button type="submit" variant="outline" disabled={saving}>{saving ? "Saving…" : "Save planning preferences"}</Button>
            </form>
          </Panel>
        </Section>

        <Section id="scheduling">
          <SchedulerPanel />
        </Section>

        <Section id="accessibility">
          <Panel title="Accessibility and feedback">
            <Check label="Reduce motion" checked={saved.motion === "reduced"} onChange={(reduced) => {
              const motion = reduced ? "reduced" as const : "full" as const;
              const before = saved;
              setSaved({ ...saved, motion });
              updatePreferences({ reducedMotion: reduced });
              void savePreferencesAction({ expectedVersion: before.version, motion }).then((result) => {
                if (result.ok) { setSaved(result.preferences); return; }
                setSaved(before);
                updatePreferences({ reducedMotion: before.motion === "reduced" });
                notify(result.error);
              });
            }}/>
            <Check label="Enable completion celebrations (this browser preview only)" checked={state.preferences.celebrations} onChange={(celebrations) => updatePreferences({ celebrations })}/>
            <p className="mt-2 text-xs text-muted-foreground">Motion saves to your account. Appearance is set by the header toggle, which also saves to your account; system reduced-motion settings remain respected.</p>
          </Panel>
        </Section>

        <Section id="appearance">
          <Panel title="Appearance" description="No appearance overrides.">
            <p className="text-[13px] leading-relaxed text-muted-foreground">The header toggle cycles light, dark and system, and saves the choice to your account, so a new browser adopts it on first load. One accent colour is used across all three products; per-surface palette switching is not offered.</p>
          </Panel>
        </Section>

        {serverAssistantProfile ? (
        <Section id="assistant">
          <AssistantPanel profile={serverAssistantProfile} />
        </Section>
        ) : null}

        <Section id="execution-safety">
          <Panel title="Execution safety" actions={<Status>{state.preferences.killSwitch ? "Preview kill switch enabled" : "Preview kill switch disabled"}</Status>}>
            <Check label="Keep agent execution and paid-call intent paused" checked={state.preferences.killSwitch} onChange={(killSwitch) => updatePreferences({ killSwitch })}/>
            <p className="mt-3 text-[13px] text-muted-foreground">This preference is local-only. No agent runtime is connected, and disabling it does not enable any paid call or external write. A production kill switch must fence server-side claims and running work; it cannot recall in-flight provider effects.</p>
          </Panel>
        </Section>

        <Section id="model-policy">
          <Panel title="Model and tool policy" description="Profile, model routing and tool allowlists are server-owned.">
            <Unavailable feature="Assistant profile and tool policy">Model choice, reasoning effort, allowed tools and per-run budgets are captured server-side when a run starts. Nothing on this screen can widen them.</Unavailable>
            <div className="mt-4 flex flex-wrap gap-2"><Destination screen="reviews">External action reviews</Destination><Destination screen="spending">Spending policy</Destination></div>
          </Panel>
        </Section>

        <Section id="connectors">
          <Panel title="Connector state" description="See the connection catalog.">
            <Unavailable feature="Connector credentials">Provider secrets never reach this browser. Account connection, aliasing and revocation are server-side domain commands against Composio.</Unavailable>
            <div className="mt-4"><Destination screen="integrations">Open connection catalog</Destination></div>
          </Panel>
          <CapabilityPanel capabilities={capabilities} />
        </Section>

        <Section id="documents">
          <Panel title="Document automation policy" description="Automatic classification and rename are unavailable; manual classification stays usable.">
            <DisabledAction reason="Versioned document policies, extraction and model adapters must be configured.">Enable classification suggestions</DisabledAction>
            <div className="mt-4"><Destination screen="documents">Classify manually</Destination></div>
          </Panel>
        </Section>

        <Section id="account">
          <Panel title="Account and machine clients" description="API keys let the Chrome companion, scripts and agents authenticate. Only the key's digest is stored; the secret is shown once at creation.">
            <ApiKeysPanel />
          </Panel>
        </Section>

        <Section id="data-retention">
          {browserPreview ? (
          <Panel title="Data and retention" description="What this preview stores, and where it stops.">
            <dl className="grid gap-3 text-[13px]">
              <div><dt className="text-muted-foreground">Stored</dt><dd>Tasks, notes and checkpoints, captures, contacts, reviews, preferences and activity, in this browser&apos;s local storage.</dd></div>
              <div><dt className="text-muted-foreground">Sent anywhere</dt><dd>Nothing. No provider, model or analytics call is made from this preview.</dd></div>
              <div><dt className="text-muted-foreground">Retention</dt><dd>Until you clear the browser preview, or your browser clears site data.</dd></div>
            </dl>
          </Panel>
          ) : (
          <Panel title="Data and retention" description="Where your account data lives on this deployment.">
            <dl className="grid gap-3 text-[13px]">
              <div><dt className="text-muted-foreground">Stored</dt><dd>Timezone, week start, appearance and motion save to your account on this deployment&apos;s server and load on every signed-in device.</dd></div>
              <div><dt className="text-muted-foreground">Sent anywhere</dt><dd>Which providers this deployment can call is read from its environment and named under Configured capabilities above.</dd></div>
              <div><dt className="text-muted-foreground">Retention</dt><dd>Saved settings persist on the server; they are not tied to this browser.</dd></div>
            </dl>
          </Panel>
          )}
        </Section>

        <Section id="candidate-facts">
          <Panel title="Candidate facts and résumé setup" description="Structured facts about the owner, reused by the assistant when it drafts or reviews career material.">
            <Button variant="outline" onClick={() => setFactsOpen(!factsOpen)}>{factsOpen ? "Close candidate facts" : "Prepare candidate facts and résumé setup"}</Button>
            {factsOpen && <div className="mt-4"><CandidateFacts/></div>}
          </Panel>
        </Section>

        <Section id="reset">
          <Panel title="Reset browser preview" description={browserPreview
            ? "Clear local edits, notes, checkpoints, tasks and review decisions back to an empty workspace. No production or provider data is affected."
            : "Clear this browser's local preview edits only - notes, checkpoints, tasks and review decisions stored in this browser. Your account settings and server records are not affected."}>
            <Dialog open={resetOpen} onOpenChange={(open) => { setResetOpen(open); setConfirmation(""); }}>
              <DialogTrigger asChild><Button variant="outline">Clear preview data</Button></DialogTrigger>
              <DialogContent>
                <DialogTitle>Replace all preview changes?</DialogTitle>
                <DialogDescription>This clears the shared browser workspace used by all three products. Your local edits and saved notes will be lost. Download any notes you need first.</DialogDescription>
                <Field label="Type RESET to confirm"><Input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off"/></Field>
                <Button disabled={confirmation !== "RESET"} onClick={() => { resetPreview(); setResetOpen(false); setConfirmation(""); }}>Confirm reset</Button>
              </DialogContent>
            </Dialog>
          </Panel>
        </Section>
      </div>
    </div>
  </Screen>;
}
