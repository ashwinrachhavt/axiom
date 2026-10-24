import { expect, type Page } from "@playwright/test";

/*
 * Axe composites the background it samples through whatever opacity and
 * transition state an element is in. Three separate flake classes came from
 * sampling inside a transition window: the topbar buttons sit at
 * disabled:opacity-50 until hydration and the `disabled` attribute flips
 * before the opacity transition (transition-all) finishes, so toBeEnabled
 * resolves on a still-fading button. Every axe run goes through here.
 */
export async function waitSettled(page: Page, landmarks: { capture?: boolean; heading?: string } = {}) {
  // Hydration: the header search is disabled until the client store hydrates.
  // The /alfred/* destinations render headerless (b5b1d26: the conversation is
  // home), so their shell holds no search trigger at all — a trigger that
  // never appears would hang this wait forever there. Wait only when one is
  // actually in the DOM; the rail's copy sits in a `hidden md:block` nav, so
  // below md only the topbar's copy exists, and on a headerless page neither
  // does.
  if (landmarks.capture !== false) {
    const trigger = page.getByRole("button", { name: "Search workspace", exact: true });
    if (await trigger.count()) {
      await expect(trigger.first()).toBeEnabled();
    }
  }
  // Async client-only surfaces (the Notebook rich editor toolbar mounts
  // through immediatelyRender: false) hold disabled buttons a frame longer.
  if (landmarks.heading) await expect(page.getByRole("button", { name: landmarks.heading, exact: true })).toBeEnabled();
  // No animation anywhere is mid-flight: every transitioning element has
  // reached its computed opacity. Permanently disabled buttons (the Ask-AI
  // controls) hold disabled:opacity-50 forever, so they are excluded; the
  // hydration fade only affects buttons that end enabled. Reduced motion
  // collapses transitions, so the check is for the settle path only.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].every((element) => {
      if ((element as HTMLButtonElement).disabled) return true;
      const opacity = getComputedStyle(element).opacity;
      return opacity !== "" && Number(opacity) > 0.99;
    }),
  );
  // Colors animate too: a button can hold full opacity while its background
  // and foreground are still interpolating, and axe samples those intermediate
  // values (a Capture button caught mid-transition reads at 2.8:1). Wait for
  // every finite CSS transition to finish. Looping animations (loading pulses)
  // never finish, so they are excluded rather than waited on forever.
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      const timing = (animation.effect as KeyframeEffect | null)?.getTiming();
      return timing?.iterations === Infinity || animation.playState !== "running";
    }),
  );
}
