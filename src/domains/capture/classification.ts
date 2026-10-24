/*
 * The capture classification ladder's deterministic tiers. Pure functions: no
 * DB, no model, no clock — fixture-testable and free to run. The outbox
 * handler (enrichment-handler.ts) calls these, then escalates to the LLM tier
 * only when the heuristics are not confident enough on their own.
 *
 * Tier 0 normalizes: collapse the copy-paste noise (soft hyphens, zero-width
 * characters, CRLF, trailing whitespace, >2 blank lines) so every later tier
 * reads the same cleaned text. The original stays in raw_payload untouched.
 *
 * Tier 1 classifies structure by regex heuristics. Cheap and inspectable:
 * every verdict carries the signal that produced it, so a misclassification
 * is diagnosable without re-running anything.
 */

export const STRUCTURES = ["prose", "code", "list", "url", "contact", "log", "empty"] as const;
export type Structure = (typeof STRUCTURES)[number];

export type Tier1Result = {
  structure: Structure;
  /** What the heuristic saw, e.g. "fenced ```ts block". Shown in the UI. */
  signals: string[];
};

export type Classification = {
  cleanText: string;
  charCount: number;
  structure: Structure;
  signals: string[];
};

/** Above this, the handler escalates to the LLM tier. */
export const LLM_THRESHOLD_CHARS = 280;
/** Hard input cap for the LLM tier; the tail beyond this is not read. */
export const LLM_MAX_INPUT_CHARS = 12_000;
export const MAX_TAGS = 5;

export function normalizeCapturedText(raw: string): string {
  return raw
    .replace(/­/g, "") // soft hyphen
    .replace(/[​-‏﻿]/g, "") // zero-width and BOM
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function classifyStructure(cleanText: string): Tier1Result {
  const trimmed = cleanText.trim();
  if (!trimmed) return { structure: "empty", signals: [] };

  const signals: string[] = [];

  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return { structure: "url", signals: ["single bare URL"] };
  }

  const fenced = trimmed.match(/^```[\w+-]*\n[\s\S]*\n```$/m);
  if (fenced) {
    const lang = trimmed.match(/^```([\w+-]*)/m)?.[1];
    return { structure: "code", signals: [lang ? `fenced block (${lang})` : "fenced block"] };
  }

  const lines = trimmed.split("\n");
  if (trimmed.length >= 24 && lines.length >= 3) {
    const bulletish = lines.filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length;
    if (bulletish / lines.length >= 0.6) {
      return { structure: "list", signals: [`${bulletish}/${lines.length} lines bulleted`] };
    }
  }

  // A log: many lines stamped with a leading date/time.
  if (lines.length >= 5) {
    const stamped = lines.filter((l) =>
      /^\[?\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}(:\d{2})?(\s?(AM|PM|am|pm))?\]?\s/.test(l),
    ).length;
    if (stamped / lines.length >= 0.7) {
      return { structure: "log", signals: [`${stamped}/${lines.length} lines timestamped`] };
    }
  }

  // A contact block: enough labeled identity fields on their own lines.
  if (lines.length <= 12) {
    const contactFields = lines.filter((l) =>
      /(^|\s)(phone|tel|mobile|email|e-mail|address|linkedin|github|handle)\s*[:\-–]/i.test(l) ||
      /[\w.+-]+@[\w-]+\.[\w.]+/.test(l) ||
      /^\+?[\d\s().-]{7,}$/.test(l),
    ).length;
    if (contactFields >= 2) {
      return { structure: "contact", signals: [`${contactFields} contact fields`] };
    }
  }

  const codeish = lines.filter((l) =>
    /[=;{}()<>]=?|=>|::|\b(function|const|let|var|return|import|class|def|end)\b/.test(l),
  ).length;
  if (lines.length >= 4 && codeish / lines.length >= 0.7 && trimmed.length > 120) {
    return { structure: "code", signals: [`${codeish}/${lines.length} lines code-shaped`] };
  }

  signals.push("default prose");
  return { structure: "prose", signals };
}

export function classifyCapture(raw: string): Classification {
  const cleanText = normalizeCapturedText(raw);
  const { structure, signals } = classifyStructure(cleanText);
  return { cleanText, charCount: cleanText.length, structure, signals };
}
