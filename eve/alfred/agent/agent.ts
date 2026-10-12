import { defineAgent } from "eve";

/*
 * Alfred: one first-party agent (agents/product.md — not a persona zoo). The
 * model id is a default; the run's frozen policy snapshot is what the engine
 * prices and bounds, and profiles stay resolvable from the schema.
 */
export default defineAgent({
  model: "anthropic/claude-sonnet-5",
});
