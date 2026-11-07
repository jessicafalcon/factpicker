import type { VideoRow } from "./types.ts";
import { normalizeText } from "./normalize.ts";

/**
 * Vertex text embeddings, used as a cheap independent signal.
 *
 * This is deliberately NOT the primary classifier: a stance is an argument-level
 * judgement, and cosine similarity to "support"/"attack" anchors cannot separate
 * "he attacks X" from "X attacks him". It is useful for (a) a prior when the
 * model is silent, (b) clustering near-duplicate posts, and (c) triaging which
 * videos deserve an LLM call. The ablation script measures how far it gets
 * before we rely on it.
 */

export interface EmbeddingConfig {
  project: string;
  location?: string;
  model?: string;
  accessToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";

export async function embedTexts(config: EmbeddingConfig, texts: string[]): Promise<number[][]> {
  const {
    project,
    location = "us-central1",
    model = DEFAULT_EMBEDDING_MODEL,
    timeoutMs = 30_000,
    fetchImpl = fetch,
  } = config;

  const accessToken = config.accessToken ?? process.env.GOOGLE_ACCESS_TOKEN;
  if (!accessToken) throw new Error("embedTexts needs an access token (GOOGLE_ACCESS_TOKEN or config.accessToken)");

  const url =
    `https://${location}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${location}/publishers/google/models/${model}:predict`;

  const out: number[][] = [];
  const BATCH = 5;

  for (let index = 0; index < texts.length; index += BATCH) {
    const batch = texts.slice(index, index + BATCH).map((text) => ({ content: text.slice(0, 8_000) }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ instances: batch }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Embeddings ${response.status}: ${text.slice(0, 250)}`);
      const payload: any = JSON.parse(text);
      for (const prediction of payload.predictions ?? []) {
        out.push(prediction.embeddings?.values ?? []);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** French anchor phrases, candidate-agnostic so they generalise across names. */
export const STANCE_ANCHORS = {
  favorable: [
    "Je soutiens ce candidat, je vote pour lui et je le défends.",
    "C'est le meilleur candidat, le seul capable de changer les choses.",
    "Bravo, courage et respect pour ce qu'il fait, je suis fier de le soutenir.",
    "Son programme est crédible et concret, il a raison sur ce sujet.",
    "Notre candidate défend les gens, elle est à la hauteur.",
  ],
  critical: [
    "Ce candidat est dangereux, incompétent et menteur.",
    "Il est corrompu, il a trahi ses électeurs, quelle honte.",
    "C'est un scandale, ce type est une catastrophe pour la France.",
    "Je ne supporte plus ce candidat, il faut le dégager.",
    "Ses promesses sont des mensonges, il se moque des gens.",
  ],
  neutral: [
    "Voici la liste des candidats déclarés à l'élection présidentielle.",
    "Le candidat était présent au salon et a pris la parole devant les agriculteurs.",
    "Selon un sondage, ce candidat est à douze pour cent des intentions de vote.",
    "Il a annoncé sa candidature lors d'une conférence de presse.",
    "Retrouvez l'interview du candidat ce soir dans le journal.",
  ],
} as const;

export interface AnchorScore {
  label: "favorable" | "critical" | "neutral" | "unclear";
  score: number;
  favorable: number;
  critical: number;
  neutral: number;
  /** Second-best gap, used to express confidence in the anchor decision. */
  margin: number;
}

/** Aggregates similarities to each anchor family into a stance score. */
export function scoreAnchors(similarities: Array<{ family: keyof typeof STANCE_ANCHORS; value: number }>): AnchorScore {
  const top = (family: keyof typeof STANCE_ANCHORS, n = 2) =>
    similarities
      .filter((entry) => entry.family === family)
      .map((entry) => entry.value)
      .sort((a, b) => b - a)
      .slice(0, n)
      .reduce((sum, value, _, array) => sum + value / array.length, 0);

  const favorable = top("favorable");
  const critical = top("critical");
  const neutral = top("neutral");
  const score = Number((favorable - critical).toFixed(4));

  // Margins are tiny (0.02-0.08) with embedding models, so the decision rule is
  // relative, not an absolute threshold.
  const best = Math.max(favorable, critical, neutral);
  const margin = Number((best - [favorable, critical, neutral].sort((a, b) => b - a)[1]).toFixed(4));

  let label: AnchorScore["label"] = "neutral";
  if (neutral >= Math.max(favorable, critical) - 0.005) label = "neutral";
  else if (score > 0.01) label = "favorable";
  else if (score < -0.01) label = "critical";
  else label = "unclear";

  return { label, score, favorable: Number(favorable.toFixed(4)), critical: Number(critical.toFixed(4)), neutral: Number(neutral.toFixed(4)), margin };
}

export function videoText(video: VideoRow): string {
  return [video.caption ?? "", ...(video.on_screen_text ?? []), video.transcript ?? ""]
    .filter(Boolean)
    .join("\n")
    .slice(0, 6_000);
}

/** Convenience wrapper: embed the video and every anchor, then score. */
export async function anchorClassify(config: EmbeddingConfig, video: VideoRow): Promise<AnchorScore & { text: string }> {
  const anchors = Object.entries(STANCE_ANCHORS).flatMap(([family, phrases]) =>
    phrases.map((phrase) => ({ family: family as keyof typeof STANCE_ANCHORS, phrase })),
  );
  const text = videoText(video);
  const vectors = await embedTexts(config, [text, ...anchors.map((anchor) => anchor.phrase)]);
  const [videoVector, ...anchorVectors] = vectors;
  const similarities = anchors.map((anchor, index) => ({
    family: anchor.family,
    value: cosine(videoVector, anchorVectors[index]),
  }));
  return { ...scoreAnchors(similarities), text };
}

/** Rough duplicate detector for the same clip reused across candidate files. */
export function textFingerprint(video: VideoRow): string {
  // Strip punctuation too, so reposts that differ only in "!" or ellipses hash
  // to the same fingerprint.
  return normalizeText(videoText(video))
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}
