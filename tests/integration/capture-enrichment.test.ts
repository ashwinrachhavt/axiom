import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { workspaces } from "@/domains/identity/schema";
import { captures } from "@/domains/capture/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * The enrichment ladder runs as an outbox consumer behind the URL handler.
 * Verified here: enqueue on every capture (URL tier delayed 30s so the scrape
 * lands first), Tier 0+1 landing on the row without any model, the LLM tier
 * writing title/domain/tags as signal, unconfigured-provider skipping instead
 * of failing, and a readable-but-wrong model answer degrading to enriched
 * with the deterministic tiers intact rather than retrying forever.
 */

const generate = vi.fn();

vi.mock("@/integrations/generation/provider", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/integrations/generation/provider")>();
  return {
    ...original,
    generationProvider: vi.fn(() => ({
      name: "test:model",
      registryId: "test",
      generate: (...args: unknown[]) => generate(...(args as [])),
    })),
  };
});

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/capture/commands");
let handler: typeof import("@/domains/capture/enrichment-handler");
let auth: AuthContext;
let workspaceId: string;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/capture/commands");
  handler = await import("@/domains/capture/enrichment-handler");
  const seeded = await seedWorkspace(db, `capture-enrichment-${Date.now()}`);
  workspaceId = seeded.workspaceId;
  auth = ownerAuth(seeded.userId, workspaceId);
});

afterAll(async () => {
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await handle?.client.end();
});

const { generationProvider } = await import("@/integrations/generation/provider");

beforeEach(() => {
  generate.mockReset();
  vi.mocked(generationProvider).mockReset();
  vi.mocked(generationProvider).mockImplementation(() => ({
    name: "test:model",
    registryId: "test",
    generate: (...args: unknown[]) => generate(...(args as [])),
  }) as never);
});

async function enqueueAndRun(captureId: string) {
  const events = await db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.topic, handler.CAPTURE_ENRICHMENT_TOPIC));
  const event = events.find((e) => (e.payload as { captureId: string }).captureId === captureId);
  if (!event) throw new Error("no enrichment event enqueued");
  await handler.captureEnrichmentRequestedHandler({
    id: event.id,
    workspaceId,
    topic: event.topic,
    payload: event.payload,
  } as Parameters<typeof handler.captureEnrichmentRequestedHandler>[0]);
}

async function getCapture(id: string) {
  const [row] = await db.select().from(captures).where(eq(captures.id, id)).limit(1);
  return row;
}

suite("capture enrichment ladder", () => {
  it("enqueues enrichment for a text capture immediately and a URL capture delayed", async () => {
    const text = await commands.createCapture(auth, { text: "A short thought." });
    const page = await commands.createCapture(auth, { text: "https://example.com/article" });

    const events = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.topic, handler.CAPTURE_ENRICHMENT_TOPIC));
    const byCapture = new Map(events.map((e) => [(e.payload as { captureId: string }).captureId, e]));
    const textEvent = byCapture.get(text.id);
    const urlEvent = byCapture.get(page.id);
    expect(textEvent).toBeDefined();
    expect(urlEvent).toBeDefined();
    // The URL capture's enrichment waits for the scrape (due in the future);
    // the text capture's is due now.
    expect(textEvent!.availableAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(urlEvent!.availableAt.getTime()).toBeGreaterThan(Date.now() + 10_000);
  });

  it("runs Tier 0+1 only on short text: no model call, row lands enriched", async () => {
    const capture = await commands.createCapture(auth, { text: "A short thought." });
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.cleanText).toBe("A short thought.");
    expect(row.structure).toBe("prose");
    expect(generate).not.toHaveBeenCalled();
  });

  it("skips the model for structure captures: URL, code, list", async () => {
    const code = await commands.createCapture(auth, {
      text: "```ts\nconst a = 1;\nconst b = 2;\nconst c = a + b;\n```",
    });
    await enqueueAndRun(code.id);
    const row = await getCapture(code.id);
    expect(row.structure).toBe("code");
    expect(row.processingState).toBe("enriched");
    expect(generate).not.toHaveBeenCalled();
  });

  it("escalates long prose to the LLM and stores title, domain, tags", async () => {
    generate.mockResolvedValue({
      text: JSON.stringify({ title: "Quarterly planning notes", domain: "product", tags: ["planning", "q4"] }),
    });
    const prose = Array.from({ length: 12 }, (_, i) => `This is sentence ${i} of a longer captured essay on planning the quarter ahead with care.`).join(" ");
    const capture = await commands.createCapture(auth, { text: prose });
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.title).toBe("Quarterly planning notes");
    expect(row.domain).toBe("product");
    expect(row.tags).toEqual(["planning", "q4"]);
    expect(generate).toHaveBeenCalledTimes(1);
    const prompt = generate.mock.calls[0][0] as { prompt: string };
    expect(prompt.prompt).toContain("<<<BEGIN_DOCUMENT>>>");
  });

  it("skips to enriched when no generation provider is configured", async () => {
    const { GenerationUnconfiguredError } = await import("@/integrations/generation/provider");
    vi.mocked(generationProvider).mockImplementation(() => {
      throw new GenerationUnconfiguredError();
    });
    const prose = Array.from({ length: 12 }, (_, i) => `Sentence ${i}: prose long enough to want the model tier today.`).join(" ");
    const capture = await commands.createCapture(auth, { text: prose });
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.structure).toBe("prose");
    expect(row.cleanText).toBeTruthy();
  });

  it("degrades an unreadable model answer to enriched with tiers 0+1 intact", async () => {
    generate.mockResolvedValue({ text: "not json at all" });
    const prose = Array.from({ length: 12 }, (_, i) => `Sentence ${i} of deliberate prose for the unreadable-answer case here.`).join(" ");
    const capture = await commands.createCapture(auth, { text: prose });
    await enqueueAndRun(capture.id);

    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("enriched");
    expect(row.failureReason).toContain("unreadable");
    expect(row.cleanText).toBeTruthy();
  });

  it("leaves a converted capture untouched", async () => {
    const capture = await commands.createCapture(auth, { text: "A short thought." });
    await db
      .update(captures)
      .set({ processingState: "converted" })
      .where(eq(captures.id, capture.id));
    await enqueueAndRun(capture.id);
    const row = await getCapture(capture.id);
    expect(row.processingState).toBe("converted");
    expect(row.cleanText).toBeNull();
  });
});
