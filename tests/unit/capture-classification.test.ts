import { describe, expect, it } from "vitest";
import {
  LLM_THRESHOLD_CHARS,
  classifyCapture,
  classifyStructure,
  normalizeCapturedText,
} from "@/domains/capture/classification";

/*
 * Tier 0 + 1 of the capture ladder are pure: normalization strips copy-paste
 * noise without touching meaning; structure heuristics must earn each verdict
 * with a visible signal and stay conservative — prose is the fallback, so the
 * tests pin the cases that must NOT be pulled away from it.
 */

describe("normalizeCapturedText", () => {
  it("strips soft hyphens, zero-width characters, and BOM", () => {
    expect(normalizeCapturedText(" deci­sion​ ")).toBe("decision");
    expect(normalizeCapturedText("﻿hello")).toBe("hello");
  });

  it("normalizes CRLF and collapses blank-line runs", () => {
    expect(normalizeCapturedText("a\r\n\r\n\r\n\r\nb")).toBe("a\n\nb");
  });

  it("trims trailing whitespace per line", () => {
    expect(normalizeCapturedText("a   \nb\t")).toBe("a\nb");
  });
});

describe("classifyStructure", () => {
  it("calls a single bare URL", () => {
    expect(classifyStructure("https://example.com/a?b=1")).toEqual({
      structure: "url",
      signals: ["single bare URL"],
    });
  });

  it("calls a fenced code block with its language", () => {
    const result = classifyStructure("```ts\nconst x: number = 1;\n```");
    expect(result.structure).toBe("code");
    expect(result.signals).toEqual(["fenced block (ts)"]);
  });

  it("calls a bulleted list", () => {
    const text = ["Ideas:", "- one", "- two", "- three", "* four"].join("\n");
    expect(classifyStructure(text).structure).toBe("list");
  });

  it("calls a timestamped log", () => {
    const lines = Array.from({ length: 6 }, (_, i) => `2026-10-23 10:0${i} thing happened ${i}`).join("\n");
    expect(classifyStructure(lines).structure).toBe("log");
  });

  it("calls a contact block on labeled fields", () => {
    const text = ["Jane Doe", "email: jane@example.com", "phone: +1 555 0100"].join("\n");
    expect(classifyStructure(text).structure).toBe("contact");
  });

  it("stays prose for short or ordinary text", () => {
    expect(classifyStructure("A short thought.").structure).toBe("prose");
    const prose = Array.from({ length: 5 }, (_, i) => `Paragraph ${i} with ordinary sentence words.`).join("\n\n");
    expect(classifyStructure(prose).structure).toBe("prose");
  });

  it("calls empty text empty", () => {
    expect(classifyStructure("   ").structure).toBe("empty");
  });
});

describe("classifyCapture", () => {
  it("returns cleaned text and char count alongside the verdict", () => {
    const result = classifyCapture("  deci­sion​ needed\r\n\r\n\r\n\r\non the thing  ");
    expect(result.cleanText).toBe("decision needed\n\non the thing");
    expect(result.charCount).toBe(result.cleanText.length);
  });

  it("keeps short prose under the LLM threshold", () => {
    const result = classifyCapture("A brief thought worth keeping.");
    expect(result.structure).toBe("prose");
    expect(result.cleanText.length).toBeLessThan(LLM_THRESHOLD_CHARS);
  });
});
