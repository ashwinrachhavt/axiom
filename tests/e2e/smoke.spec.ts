import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { destinations } from "../../src/lib/navigation";
import { removeSeededRuns, seedRun } from "./helpers/runs";
import { waitSettled } from "./helpers/settled";

test.afterAll(async () => {
  await removeSeededRuns();
});

test("home opens Assistant", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/alfred");
  await expect(page.locator("#content h1")).toHaveText("What would you like to work on?");
  // The Assistant reads canonical runs; the preview banner must not claim otherwise.
  await expect(page.getByText("Interactive preview", { exact: true })).toHaveCount(0);
});

/*
 * The home is a conversation surface now: greeting, one composer, then history.
 * The copy that described the old run-launcher screen must be gone from the
 * rendered page, not merely absent from the source — a stale branch in a
 * conditional would still ship it.
 */
test("the Assistant home carries only the new conversation copy", async ({ page }) => {
  await page.goto("/alfred");
  await expect(page.locator("#content h1")).toHaveText("What would you like to work on?");
  const composer = page.getByRole("textbox", { name: "Start a conversation" });
  await expect(composer).toHaveAttribute("placeholder", "Ask anything or describe a task…");

  const body = page.locator("body");
  for (const gone of [
    "Hand off work and inspect what it did",
    "Start a run",
    "No threads yet",
    "Recent runs",
    "You:",
    "Assistant:",
  ]) {
    await expect(body, gone).not.toContainText(gone);
  }
});

test("the rail leads with Polymath, then Today", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/alfred");
  // The home streams: the shell hydrates and the Suspense boundary swaps its
  // content in. Reading the DOM before that settles throws "Execution context
  // was destroyed, most likely because of a navigation" — the page was still
  // replacing itself, not changing route.
  await waitSettled(page);
  // Destination links carry their label as an accessible name; the wordmark's
  // name comes from its visible text, so it does not match a[aria-label] and is
  // excluded by the query itself.
  const labels = await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .locator("a[aria-label]")
    .evaluateAll((links) => links.map((link) => link.getAttribute("aria-label")));
  expect(labels.slice(0, 2)).toEqual(["Polymath", "Today"]);
});

/*
 * The canonical routes. The unit layer tests the navigation lib; this journey
 * proves the routes themselves render — a broken destinationForPath, shell,
 * or dropped page file fails here.
 */
test("canonical routes render", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page).toHaveURL("/alfred");
  await expect(page.locator("#content h1")).toHaveText("What would you like to work on?");

  for (const [path, heading] of [
    ["/neuralflow/work", "Work"],
    ["/alfred/knowledge", "Knowledge"],
    ["/more", "More"],
  ] as const) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator("#content h1"), path).toContainText(heading);
  }
  expect(errors).toEqual([]);
});

test("rail destinations are real screens", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const destination of destinations) {
    const response = await page.goto(destination.href);
    expect(response?.status(), destination.href).toBe(200);
    // Route-level loading.tsx renders a second skeleton <main>; scope to
    // the shell's content main so navigation never races the skeleton.
    await expect(page.locator("#content h1")).toHaveCount(1);
    await expect(page.locator("#content")).not.toContainText("Nothing is here");
    // Scope to the aria-labeled destination link: the rail's wordmark is also
    // a link whose accessible name is "Polymath" (from its visible text), and
    // since b5b1d26 renamed the first destination to Polymath a plain
    // getByRole('link', name) collides between the two.
    await expect(page.getByRole("navigation", { name: "Workspace", exact: true }).getByLabel(destination.label, { exact: true })).toHaveAttribute("aria-current", "page");
  }
  expect(errors).toEqual([]);
});

test("the launcher lists destinations and shared routes are reachable", async ({ page }) => {
  await page.goto("/command-center/briefing");
  await page.getByRole("button", { name: "Open destinations" }).click();
  const launcher = page.getByRole("dialog");
  await expect(launcher).toBeVisible();
  await expect(launcher.getByRole("link", { name: "Work", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(launcher).toBeHidden();
  // Shared, unprefixed routes render under the same shell (no redirect to /apps).
  for (const shared of ["/reviews", "/settings", "/activity"]) {
    const response = await page.goto(shared);
    expect(response?.status(), shared).toBe(200);
    await expect(page).not.toHaveURL(/^https?:\/\/[^/]*\/apps\//);
  }
});

test("the destination launcher is keyboard reachable and closes on escape", async ({ page }) => {
  await page.goto("/neuralflow/work");
  const trigger = page.getByRole("button", { name: "Open destinations" });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
});

/*
 * A run row on home is a conversation, not a status board: the objective and
 * its age, nothing else. The waiting-on-you vocabulary lives in Reviews by
 * design (see the run page's comment), so no status words belong on the row.
 * `waiting_approval` is only reachable after a model asks for a proposal, so
 * the row is seeded directly.
 */
test("a run row on home names the objective, and nothing else", async ({ page }) => {
  const objective = `Approve the renewal letter ${Date.now().toString(36)}`;
  const run = await seedRun({ objective, state: "waiting_approval" });
  test.skip(!run, "Seeding a waiting run needs DATABASE_URL.");

  await page.goto("/alfred");
  const row = page.getByRole("link", { name: new RegExp(objective) });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("href", `/alfred/${run!.id}`);
  // No status vocabulary on the row: Reviews owns "needs you", and internal
  // state names are never the words of the screen.
  for (const status of ["Needs your reply", "Running", "In progress", "Queued", "Succeeded", "waiting_approval"]) {
    await expect(row, status).not.toContainText(status);
  }
  // The row is a conversation, not a debug line: no model, no transcript prefix.
  await expect(row).not.toContainText("You:");
  await expect(row).not.toContainText("Assistant:");
});

/*
 * The conversation page: the transcript is the page, controls live under it,
 * and a run id that is not this workspace's is the same answer as one that
 * never existed. The shell's loading.tsx commits before notFound() runs, so
 * the response is 200 with not-found content — assert the content, never the
 * status.
 */
test("a run opens its conversation, with controls under the transcript", async ({ page }) => {
  const objective = `Draft the renewal letter ${Date.now().toString(36)}`;
  const run = await seedRun({ objective, state: "waiting_approval" });
  test.skip(!run, "Opening a conversation needs DATABASE_URL.");

  await page.goto(`/alfred/${run!.id}`);
  // The streaming shell can leave the streamed subtree mounted twice in dev;
  // every locator below is scoped to the first content main so strict mode
  // sees one page.
  const content = page.locator("#content").first();
  await expect(content.locator("h1")).toHaveText(objective);
  const conversation = content.getByRole("region", { name: "Conversation" });
  await expect(conversation).toBeVisible();
  await expect(conversation.getByText("This conversation has no messages yet.")).toBeVisible();
  // Approvals are decided in Reviews; that surface owns the waiting-on-you
  // vocabulary, so the conversation page grows no status badge of its own.
  await expect(content.getByText("Needs your reply")).toHaveCount(0);

  // A waiting run is live from the page's point of view: the composer offers a
  // follow-up and a stop, and the draft control (nothing produced yet) stays
  // out of the way.
  await expect(conversation.getByRole("textbox", { name: "Follow-up message" })).toBeVisible();
  await expect(conversation.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(conversation.getByRole("button", { name: "Save the answer as a draft" })).toHaveCount(0);
});

test("a finished run shows its retry and draft controls instead of a composer", async ({ page }) => {
  const objective = `Summarize the vendor terms ${Date.now().toString(36)}`;
  const run = await seedRun({ objective, state: "succeeded" });
  test.skip(!run, "Opening a conversation needs DATABASE_URL.");

  await page.goto(`/alfred/${run!.id}`);
  const content = page.locator("#content").first();
  await expect(content.locator("h1")).toHaveText(objective);
  const conversation = content.getByRole("region", { name: "Conversation" });
  await expect(conversation).toBeVisible();
  // A finished run keeps its stored transcript (empty here) and takes Retry;
  // the live composer and its cancel button are gone.
  await expect(conversation.getByText("This conversation has no messages yet.")).toBeVisible();
  await expect(conversation.getByRole("button", { name: "Retry as a new run" })).toBeVisible();
  await expect(conversation.getByRole("textbox", { name: "Follow-up message" })).toHaveCount(0);
  // With no output to keep, the draft control renders nothing.
  await expect(conversation.getByRole("button", { name: "Save the answer as a draft" })).toHaveCount(0);
});

test("a conversation that does not exist says so, without a 404 page", async ({ page }) => {
  await page.goto("/alfred/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing is here");
  await expect(page.locator('head meta[name="robots"]')).toHaveAttribute("content", "noindex");
  // A malformed id takes the same path as a missing one, never a uuid cast error.
  await page.goto("/alfred/not-a-uuid");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing is here");
});

test("old Polymath paths redirect and unknown screens render a noindex not-found state", async ({ page }) => {
  await page.goto("/work");
  await expect(page).toHaveURL("/apps/neuralflow/tasks");
  const response = await page.goto("/apps/alfred/not-a-screen");
  expect([200, 404]).toContain(response?.status());
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing is here");
  await expect(page.locator('head meta[name="robots"]')).toHaveAttribute("content", "noindex");
});

/*
 * The IA simplification removed seven rail destinations. Six keep a redirect
 * bridge to the screen that absorbed their function (query params dropped,
 * except the notebook bridge, whose ?id= is the Notes surface's own deep link
 * and so is carried across); Learning's route was deleted entirely, so its
 * address 404s with the same noindex not-found state as any unknown screen.
 */
test("removed IA destinations redirect to their new homes, or 404 when the route is gone", async ({ page }) => {
  for (const [from, to] of [
    ["/alfred/sources", "/alfred/dossiers"],
    ["/alfred/wiki", "/alfred/knowledge"],
    ["/command-center/spending", "/command-center/briefing?tab=spending"],
    ["/command-center/opportunities", "/command-center/relationships/people"],
    ["/neuralflow/focus", "/neuralflow/work"],
  ] as const) {
    await page.goto(`${from}?stale=param`);
    await expect(page, from).toHaveURL(to);
  }
  // The old notebook address keeps the note deep link it once owned.
  await page.goto("/alfred/notebook?id=00000000-0000-4000-8000-000000000001");
  await expect(page).toHaveURL("/alfred/notes?id=00000000-0000-4000-8000-000000000001");
  await page.goto("/alfred/learning");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing is here");
  await expect(page.locator('head meta[name="robots"]')).toHaveAttribute("content", "noindex");
});

test("representative product screens meet WCAG 2.2 AA", async ({ page }) => {
  test.setTimeout(120_000);
  for (const path of ["/command-center/briefing", "/reviews", "/settings", "/neuralflow/work", "/alfred/knowledge", "/alfred/notes", "/alfred/artifacts"]) {
    await page.goto(path);
    // Axe must evaluate the settled page: the topbar buttons sit at
    // disabled:opacity-50 until hydration and transition to full opacity,
    // and axe composites whatever it samples through in-flight opacity.
    await waitSettled(page);
    // The notebook leg scans the canonical surface (B04); its rich-editor
    // toolbar only mounts with a note open, so no editor landmark here. The
    // artifacts leg scans the rail's kept-outputs list (IA simplification).
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(violations, path).toEqual([]);
  }
});

test("mobile exposes the destinations bar without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/more");
  await expect(page.locator("#content h1")).toContainText("More");
  await expect(page.getByRole("navigation", { name: "Destinations", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
