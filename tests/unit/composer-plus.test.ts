import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerPlus, type ComposerPlusItem } from "@/components/chat/composer-plus";

/*
 * The composer plus button: present when the caller has something to offer,
 * absent otherwise. Popover interactivity and the live record search are
 * Radix's and the API's; the static contract pinned here is presence,
 * labelling, and the attach item's shape, which is what the accessibility
 * and copy rules govern.
 */

const item = (label: string): ComposerPlusItem => ({
  label,
  hint: `${label} hint`,
  icon: null,
  onSelect: () => {},
});

describe("composer plus", () => {
  it("renders nothing when the caller offers no items and no reference picking", () => {
    const markup = renderToStaticMarkup(createElement(ComposerPlus, { items: [] }));
    expect(markup).toBe("");
  });

  it("renders the trigger with its accessible label when items exist", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPlus, {
        items: [item("Attach a file")],
        label: "Add to message",
      }),
    );
    expect(markup).toContain("aria-label=\"Add to message\"");
  });

  it("renders a closed-state trigger (Radix owns the open menu body)", () => {
    // Radix renders closed portal content only as the trigger; the menu body
    // mounts on open, which is Radix's behavior, not ours to pin here.
    const markup = renderToStaticMarkup(
      createElement(ComposerPlus, {
        items: [item("Pin a skill"), item("Attach a file")],
        onReference: () => {},
      }),
    );
    expect(markup).toContain("aria-haspopup=\"dialog\"");
    expect(markup).toContain("aria-expanded=\"false\"");
  });

  it("renders the trigger when onFile alone is offered", () => {
    // The menu body mounts on open (Radix's behavior, not ours to pin here);
    // the static contract is that a file-only caller still gets the button.
    const markup = renderToStaticMarkup(
      createElement(ComposerPlus, { onFile: () => {} }),
    );
    expect(markup).toContain("aria-haspopup=\"dialog\"");
  });
});
