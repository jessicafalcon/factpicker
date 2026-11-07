import type { VideoRow } from "./types.ts";
import { FEW_SHOT_INSTRUCTION } from "./stance-quality.ts";
import { evidenceIsVerbatim } from "./normalize.ts";

/**
 * Vertex AI adapter for the cases the lexicon cannot read.
 *
 * Escalation policy (idea doc: "AI only where language needs it"):
 *   - deterministic score is unclear (no lexicon hit), or
 *   - positive and negative markers are close, which usually means irony.
 * Everything else keeps the deterministic score, so a 300-video batch needs
 * tens of model calls, not 300.
 *
 * No client library: a single REST call with an OAuth token, which works the
 * same in Cloud Run (metadata server) and locally (`gcloud auth print-access-token`).
 */

export interface VertexConfig {
  project: string;
  /** 0 disables reasoning (flash); pro requires > 0. */
  thinkingBudget?: number;
  location?: string;
  model?: string;
  accessToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type VertexStance = "favorable" | "critical" | "neutral" | "unclear";

export interface VertexResult {
  stance: VertexStance;
  score: number;
  rationale: string;
  evidence_quote: string;
  evidence_verified: boolean;
  model: string;
  /** Present when the API returns usageMetadata; useful for the demo trace. */
  usage?: VertexUsage;
  latencyMs?: number;
  requestId?: string | null;
}

export interface VertexUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const DEFAULT_MODEL = "gemini-2.5-flash";

/** Metadata server inside GCP, explicit env token outside. */
export async function getAccessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  const explicit = (globalThis as any).process?.env?.GOOGLE_ACCESS_TOKEN ?? (globalThis as any).Deno?.env?.get?.("GOOGLE_ACCESS_TOKEN");
  if (explicit) return explicit;

  const response = await fetchImpl(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!response.ok) {
    throw new Error(
      "No GOOGLE_ACCESS_TOKEN and no metadata server. Locally: export GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token)",
    );
  }
  const payload: any = await response.json();
  return payload.access_token;
}

export function buildVertexPrompt(input: {
  candidateName: string;
  handle: string;
  caption: string;
  onScreenText: string[];
  deterministicScore?: number;
}): string {
  return [
    "You classify the stance of ONE social video toward ONE French politician.",
    "Describe the post, never the person. Do not judge whether the claims are true.",
    "",
    `POLITICIAN: ${input.candidateName}`,
    `ACCOUNT: @${input.handle}`,
    "",
    "CAPTION:",
    input.caption || "(none)",
    "",
    "ON-SCREEN TEXT:",
    input.onScreenText.join("\n") || "(none)",
    "",
    "Return JSON only:",
    '{"stance":"favorable|critical|neutral|unclear","score":<-1..1>,"rationale":"one sentence","evidence_quote":"verbatim substring of caption or on-screen text"}',
    "",
    "Rules:",
    "- favorable = supports, defends or praises the politician.",
    "- critical = attacks, mocks or opposes the politician.",
    "- neutral = mentions them without a stance; unclear = sarcasm or too little text.",
    "- evidence_quote MUST be copied exactly from the caption or the on-screen text.",
    `- A lexicon pre-scored this video at ${input.deterministicScore ?? 0}; use it only as a hint.`,
  ].join("\n");
}

export async function classifyStance(input: {
  candidateName: string;
  handle: string;
  video: VideoRow;
  deterministicScore?: number;
  config: VertexConfig;
}): Promise<VertexResult> {
  const { candidateName, handle, video, deterministicScore, config } = input;
  const {
    project,
    location = "us-central1",
    model = DEFAULT_MODEL,
    timeoutMs = 30_000,
    fetchImpl = fetch,
  } = config;

  const started = performance.now();

  const accessToken = config.accessToken ?? (await getAccessToken(fetchImpl));
  const url =
    `https://${location}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${location}/publishers/google/models/${model}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: buildVertexPrompt({
                  candidateName,
                  handle,
                  caption: video.caption ?? "",
                  onScreenText: video.on_screen_text ?? [],
                  deterministicScore,
                }),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 800,
          responseMimeType: "application/json",
          // Gemini 2.5 spends output tokens on hidden reasoning by default,
          // which can leave the JSON part empty. Stance classification is a
          // short extraction task, so the thinking budget is disabled.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Vertex ${response.status}: ${text.slice(0, 300)}`);
    }

    const payload: any = JSON.parse(text);
    const parts: Array<{ text?: string }> = payload.candidates?.[0]?.content?.parts ?? [];
    const content = parts.map((part) => part.text ?? "").join("").trim();
    if (!content) {
      throw new Error(`Vertex returned no text (finishReason: ${payload.candidates?.[0]?.finishReason ?? "unknown"})`);
    }
    const parsed = parseJsonObject(content);

    const stance = (["favorable", "critical", "neutral", "unclear"] as string[]).includes(parsed.stance)
      ? (parsed.stance as VertexStance)
      : "unclear";
    const score = Math.max(-1, Math.min(1, Number(parsed.score ?? 0)));
    const evidence = typeof parsed.evidence_quote === "string" ? parsed.evidence_quote.trim() : "";
    const haystack = [video.caption ?? "", ...(video.on_screen_text ?? [])].join("\n");
    const usage = payload.usageMetadata
      ? {
          promptTokens: Number(payload.usageMetadata.promptTokenCount ?? 0),
          outputTokens: Number(payload.usageMetadata.candidatesTokenCount ?? 0),
          totalTokens: Number(payload.usageMetadata.totalTokenCount ?? 0),
        }
      : undefined;

    return {
      stance,
      score: Number(score.toFixed(3)),
      rationale: String(parsed.rationale ?? "").slice(0, 400),
      evidence_quote: evidence,
      evidence_verified: evidenceIsVerbatim(evidence, haystack),
      model,
      usage,
      latencyMs: performance.now() - started,
      requestId: response.headers.get("x-goog-request-id"),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(content: string): Record<string, any> {
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* ignore */
      }
    }
    return {};
  }
}

/**
 * Cost guard: which videos deserve a model call.
 * Returns the reason so the ETL can log why it spent money.
 */
export function shouldEscalate(score: {
  unclear: boolean;
  positive: number;
  negative: number;
}): { escalate: boolean; reason: string } {
  if (score.unclear) return { escalate: true, reason: "no_lexicon_signal" };
  const total = score.positive + score.negative;
  if (total === 0) return { escalate: true, reason: "no_signal" };
  const balance = Math.abs(score.positive - score.negative) / total;
  if (balance < 0.34) return { escalate: true, reason: "conflicting_markers" };
  return { escalate: false, reason: "deterministic_confident" };
}

// ── Batched classification ────────────────────────────────────────────────
// One call per VIDEO instead of per (video, candidate) pair: the model reads the
// post once and returns a stance for every candidate listed. Same information,
// a fraction of the calls.

export interface BatchTarget {
  id: string;
  name: string;
}

export interface BatchStance {
  candidate_id: string;
  stance: VertexStance;
  score: number;
  rationale: string;
  evidence_quote: string;
  evidence_verified: boolean;
  evidence_source: "caption" | "on_screen_text" | "transcript" | null;
}

const MAX_TRANSCRIPT = 5_000;

export function buildBatchPrompt(
  video: Pick<VideoRow, "caption" | "on_screen_text" | "transcript">,
  targets: BatchTarget[],
  options: { fewShot?: boolean; relevance?: string } = {},
): string {
  const transcript = (video.transcript ?? "").slice(0, MAX_TRANSCRIPT);
  return [
    "You classify how ONE social video frames each French politician listed below.",
    "Describe the post, never the person. Never judge whether claims are true.",
    "",
    "POLITICIANS:",
    ...targets.map((target) => `- ${target.id}: ${target.name}`),
    "",
    "CAPTION:",
    video.caption || "(none)",
    "",
    "ON-SCREEN TEXT:",
    (video.on_screen_text ?? []).join("\n") || "(none)",
    "",
    "TRANSCRIPT:",
    transcript || "(none)",
    "",
    "Return JSON only:",
    '{"stances":[{"candidate_id":"<id>","stance":"favorable|critical|neutral|unclear","score":<-1..1>,"rationale":"one sentence","evidence_quote":"verbatim substring","evidence_source":"caption|on_screen_text|transcript"}]}',
    "",
    "Rules:",
    "- Return one entry per listed candidate, using the exact candidate_id.",
    "- favorable = supports, defends or praises; critical = attacks, mocks or opposes.",
    "- neutral = mentions them without a stance; unclear = no signal, sarcasm, or too little text.",
    "- evidence_quote MUST be copied exactly from the field named in evidence_source.",
    "- If the post does not concern a candidate, use stance \"unclear\" and an empty evidence_quote.",
    "- neutral = the candidate is named (a list row, a news quote, a plain announcement) but the post takes no side.",
    "- unclear = you cannot tell (irony, OCR noise, no usable text).",
    options.relevance ? `- Local relevance check: ${options.relevance}.` : "",
    options.fewShot ? "\n" + FEW_SHOT_INSTRUCTION : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function classifyStancesBatch(input: {
  video: Pick<VideoRow, "caption" | "on_screen_text" | "transcript">;
  targets: BatchTarget[];
  config: VertexConfig;
  fewShot?: boolean;
  relevance?: string;
}): Promise<BatchStance[]> {
  const { video, targets, config } = input;
  if (targets.length === 0) return [];

  const {
    project,
    location = "us-central1",
    model = DEFAULT_MODEL,
    timeoutMs = 45_000,
    fetchImpl = fetch,
  } = config;

  const accessToken = config.accessToken ?? (await getAccessToken(fetchImpl));
  const url =
    `https://${location}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${location}/publishers/google/models/${model}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: buildBatchPrompt(video, targets, { fewShot: input.fewShot, relevance: input.relevance }) }],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: (config.thinkingBudget ?? 0) > 0 ? 3000 : 1200,
          responseMimeType: "application/json",
          ...((config.thinkingBudget ?? 0) >= 0 ? { thinkingConfig: { thinkingBudget: config.thinkingBudget ?? 0 } } : {}),
        },
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`Vertex ${response.status}: ${text.slice(0, 300)}`);

    const payload: any = JSON.parse(text);
    const parts: Array<{ text?: string }> = payload.candidates?.[0]?.content?.parts ?? [];
    const content = parts.map((part) => part.text ?? "").join("").trim();
    if (!content) {
      throw new Error(`Vertex returned no text (finishReason: ${payload.candidates?.[0]?.finishReason ?? "unknown"})`);
    }

    const parsed = parseJsonObject(content);
    const rows: any[] = Array.isArray(parsed.stances) ? parsed.stances : [];
    const haystacks = {
      caption: video.caption ?? "",
      on_screen_text: (video.on_screen_text ?? []).join("\n"),
      transcript: video.transcript ?? "",
    };

    return targets.map((target) => {
      const row = rows.find((entry) => entry.candidate_id === target.id) ?? {};
      const stance = (["favorable", "critical", "neutral", "unclear"] as string[]).includes(row.stance)
        ? (row.stance as VertexStance)
        : "unclear";
      const score = Math.max(-1, Math.min(1, Number(row.score ?? 0)));
      const quote = typeof row.evidence_quote === "string" ? row.evidence_quote.trim() : "";

      // Prefer the field the model named; otherwise find the quote ourselves.
      let source: BatchStance["evidence_source"] =
        row.evidence_source === "caption" || row.evidence_source === "on_screen_text" || row.evidence_source === "transcript"
          ? row.evidence_source
          : null;
      if (source && !evidenceIsVerbatim(quote, haystacks[source])) source = null;
      if (!source && quote) {
        for (const field of ["caption", "on_screen_text", "transcript"] as const) {
          if (evidenceIsVerbatim(quote, haystacks[field])) {
            source = field;
            break;
          }
        }
      }

      return {
        candidate_id: target.id,
        stance,
        score: Number(score.toFixed(3)),
        rationale: String(row.rationale ?? "").slice(0, 400),
        evidence_quote: quote,
        evidence_verified: Boolean(source && quote),
        evidence_source: source,
      };
    });
  } finally {
    clearTimeout(timer);
  }
}
