import type {
  AnalysisRow,
  CandidateDef,
  ClaimRow,
  Confidence,
  Leaning,
  SourceField,
  Tone,
  VideoRow,
} from "./types.ts";
import { TOPICS } from "./candidates.ts";
import { evidenceIsVerbatim } from "./normalize.ts";

/**
 * Offline LLM extraction. One call per (video, candidate) pair, temperature 0,
 * fixed schema. Every quote is checked against the source afterwards; the UI
 * only shows labels whose evidence survived that check. This is the answer to
 * "how do you know it isn't hallucinating?".
 */

export const PROMPT_VERSION = "framing-v1";
export const MAX_QUOTE_CHARS = 240;

export const LEANINGS: Leaning[] = ["favorable", "critical", "neutral", "unclear"];
export const TONES: Tone[] = ["informative", "critical", "mocking", "alarmed", "enthusiastic", "personal"];
export const CONFIDENCES: Confidence[] = ["low", "medium", "high"];

export function videoSourceField(video: VideoRow, field: SourceField): string {
  switch (field) {
    case "caption":
      return video.caption ?? "";
    case "transcript":
      return video.transcript ?? "";
    case "on_screen_text":
      return (video.on_screen_text ?? []).join("\n");
  }
}

export function buildPrompt(video: VideoRow, candidate: CandidateDef) {
  const text = [
    video.caption ? `CAPTION:\n${video.caption}` : "",
    video.transcript ? `TRANSCRIPT:\n${video.transcript}` : "",
    (video.on_screen_text ?? []).length ? `ON-SCREEN TEXT:\n${video.on_screen_text.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const system = [
    "You analyse how a social video frames one French politician.",
    "You describe framing. You never judge whether the claims are true, and you never label the creator.",
    "You reply with a single JSON object and nothing else.",
    "Rules:",
    `1. "evidence_quote" must be copied verbatim from the field named in "evidence_source" (${MAX_QUOTE_CHARS} chars max).`,
    "   Copy characters exactly, including accents and punctuation. If you cannot quote it, the label is worthless.",
    "2. Leaning is toward the candidate only: favorable, critical, neutral or unclear.",
    "   Neutral = the video mentions the candidate without taking a side.",
    "   Unclear = the mention is too garbled or ironic to read.",
    "3. Never infer leaning from the creator's identity, the platform or the hashtags alone.",
    "4. tone is one of: informative, critical, mocking, alarmed, enthusiastic, personal.",
    "5. confidence is low when the transcript is missing, machine-garbled, or the evidence is a bare name drop.",
    "6. claims are the factual assertions the video makes about or involving the candidate.",
    "   Each claim needs its own verbatim quote. Return at most 3. Return [] if there are none.",
    `7. issue is one of: ${Object.keys(TOPICS).join(", ")}. Use null if none fits.`,
  ].join("\n");

  const user = [
    `CANDIDATE: ${candidate.name} (${candidate.party}).`,
    `Also valid spellings you may see: ${[...candidate.aliases, ...candidate.weakAliases].join(" | ")}.`,
    `VIDEO: ${video.platform} / ${video.platform_format ?? "video"} / posted ${video.posted_at ?? "unknown"}.`,
    "",
    text || "(no text available)",
    "",
    "Return JSON with this exact shape:",
    JSON.stringify(
      {
        candidate_id: candidate.id,
        leaning: "favorable|critical|neutral|unclear",
        evidence_quote: "verbatim substring",
        evidence_source: "caption|transcript|on_screen_text",
        tone: TONES.join("|"),
        confidence: CONFIDENCES.join("|"),
        claims: [{ claim_text: "one sentence, neutral phrasing", issue: "retraites", evidence_quote: "verbatim substring" }],
      },
      null,
      2,
    ),
  ].join("\n");

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

export interface RawAnalysis {
  leaning?: string;
  evidence_quote?: string;
  evidence_source?: string;
  tone?: string;
  confidence?: string;
  claims?: Array<{ claim_text?: string; issue?: string | null; evidence_quote?: string }>;
}

export function parseAnalysis(raw: string): RawAnalysis {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed) as RawAnalysis;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as RawAnalysis;
      } catch {
        /* fall through */
      }
    }
    throw new Error("Model did not return parsable JSON");
  }
}

function clampQuote(quote: string): string {
  const clean = quote.replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_QUOTE_CHARS) return clean;
  const cut = clean.slice(0, MAX_QUOTE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
}

export interface VerifiedAnalysis {
  analysis: AnalysisRow;
  claims: ClaimRow[];
}

/**
 * Enforces the evidence contract. A label whose quote is not a verbatim
 * substring of the named field is kept but marked unverified, and its leaning
 * is downgraded to "unclear" so no unproven claim can reach the columns.
 */
export function verifyAnalysis(
  video: VideoRow,
  candidate: CandidateDef,
  raw: RawAnalysis,
  model: string | null,
): VerifiedAnalysis {
  const sourceField: SourceField =
    raw.evidence_source === "transcript" || raw.evidence_source === "on_screen_text" || raw.evidence_source === "caption"
      ? raw.evidence_source
      : video.transcript
        ? "transcript"
        : video.caption
          ? "caption"
          : "on_screen_text";

  const quote = raw.evidence_quote ? clampQuote(raw.evidence_quote) : null;
  const verified = quote ? evidenceIsVerbatim(quote, videoSourceField(video, sourceField)) : false;

  const leaning = (LEANINGS as string[]).includes(raw.leaning ?? "")
    ? (raw.leaning as Leaning)
    : "unclear";
  const tone = (TONES as string[]).includes(raw.tone ?? "")
    ? (raw.tone as Tone)
    : "informative";
  const confidence = (CONFIDENCES as string[]).includes(raw.confidence ?? "")
    ? (raw.confidence as Confidence)
    : "low";

  const analysis: AnalysisRow = {
    video_id: video.id,
    candidate_id: candidate.id,
    leaning: verified ? leaning : "unclear",
    evidence_quote: quote,
    evidence_source: quote ? sourceField : null,
    evidence_verified: verified,
    tone,
    confidence: verified ? confidence : "low",
    model,
    prompt_version: PROMPT_VERSION,
  };

  const claims: ClaimRow[] = [];
  for (const claim of raw.claims ?? []) {
    const text = claim.claim_text?.trim();
    const claimQuote = claim.evidence_quote ? clampQuote(claim.evidence_quote) : "";
    if (!text || !claimQuote) continue;
    const claimVerified = evidenceIsVerbatim(claimQuote, videoSourceField(video, sourceField));
    if (!claimVerified) continue; // unverified claims are dropped, not stored
    claims.push({
      video_id: video.id,
      candidate_id: candidate.id,
      claim_text: text,
      issue: claim.issue && claim.issue in TOPICS ? claim.issue : null,
      evidence_quote: claimQuote,
      evidence_verified: true,
    });
  }

  return { analysis, claims };
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function callLlm(
  config: LlmConfig,
  messages: Array<{ role: "system" | "user"; content: string }>,
): Promise<string> {
  const {
    baseUrl,
    apiKey,
    model,
    temperature = 0,
    maxTokens = 900,
    timeoutMs = 60_000,
    fetchImpl = fetch,
  } = config;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`LLM ${response.status}: ${text.slice(0, 300)}`);
    }
    const payload: any = JSON.parse(text);
    return payload.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

/** Runs tasks with bounded concurrency so a 300-video batch does not burst. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
