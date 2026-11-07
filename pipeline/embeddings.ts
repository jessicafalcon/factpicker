/**
 * Corpus embedding for the backend trace.
 *
 * Two modes, one interface:
 *   hash   — deterministic lexical fallback, no network, good for 209 videos
 *   vertex — gemini-embedding-001 through the REST API, cached by text hash
 *
 * The Vertex path reuses api/.cache/embeddings.json, the same cache the API's
 * embedding client writes, so a pre-warmed demo makes zero model calls.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HASH_DIMS, hashEmbedding } from "../supabase/functions/_shared/local-embeddings.ts";

export type EmbeddingMode = "hash" | "vertex";

export const HASH_MODEL = "hashed-sha256-3072";
export const VERTEX_MODEL = "gemini-embedding-001";

export interface EmbeddingOptions {
  mode: EmbeddingMode;
  model: string;
  project?: string;
  location?: string;
  accessToken?: string;
  cachePath: string;
  concurrency?: number;
  timeoutMs?: number;
}

export interface EmbeddingRun {
  vectors: number[][];
  mode: EmbeddingMode;
  model: string;
  dims: number;
  cacheHits: number;
  apiCalls: number;
  latencyMs: number;
}

const cacheKey = (model: string, text: string) =>
  createHash("sha256").update(`${model}|${text}`).digest("hex");

function loadCache(path: string): Record<string, number[]> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, number[]>;
  } catch {
    return {};
  }
}

export async function embedCorpus(texts: string[], options: EmbeddingOptions): Promise<EmbeddingRun> {
  const started = performance.now();
  if (options.mode === "hash") {
    const vectors = texts.map((text) => hashEmbedding(text));
    return {
      vectors,
      mode: "hash",
      model: HASH_MODEL,
      dims: HASH_DIMS,
      cacheHits: 0,
      apiCalls: 0,
      latencyMs: performance.now() - started,
    };
  }

  const {
    model,
    project,
    location = "us-central1",
    accessToken,
    cachePath,
    concurrency = 4,
    timeoutMs = 45_000,
  } = options;
  if (!project) throw new Error("Vertex embeddings need a GCP project");
  if (!accessToken) throw new Error("Vertex embeddings need an access token");

  const cache = loadCache(cachePath);
  const keys = texts.map((text) => cacheKey(model, text));
  const missing = texts.filter((text) => !cache[cacheKey(model, text)]);
  const cacheHits = texts.length - missing.length;

  let apiCalls = 0;
  const batches: string[][] = [];
  for (let index = 0; index < missing.length; index += 5) batches.push(missing.slice(index, index + 5));

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, batches.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= batches.length) return;
      const batch = batches[index];
      const vectors = await embedBatch({
        texts: batch,
        project,
        location,
        model,
        accessToken,
        timeoutMs,
      });
      apiCalls += 1;
      batch.forEach((text, position) => {
        cache[cacheKey(model, text)] = vectors[position];
      });
    }
  });
  await Promise.all(workers);

  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache));

  const vectors = keys.map((key) => cache[key] ?? []);
  return {
    vectors,
    mode: "vertex",
    model,
    dims: vectors[0]?.length ?? 0,
    cacheHits,
    apiCalls,
    latencyMs: performance.now() - started,
  };
}

async function embedBatch(input: {
  texts: string[];
  project: string;
  location: string;
  model: string;
  accessToken: string;
  timeoutMs: number;
}): Promise<number[][]> {
  const url =
    `https://${input.location}-aiplatform.googleapis.com/v1/projects/${input.project}` +
    `/locations/${input.location}/publishers/google/models/${input.model}:predict`;
  const body = JSON.stringify({
    instances: input.texts.map((content) => ({ content: content.slice(0, 8_000) })),
  });

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Vertex embeddings ${response.status}: ${text.slice(0, 240)}`);
      const payload = JSON.parse(text) as { predictions?: Array<{ embeddings?: { values?: number[] } }> };
      const vectors = (payload.predictions ?? []).map((prediction) => prediction.embeddings?.values ?? []);
      if (vectors.length !== input.texts.length || vectors.some((vector) => vector.length === 0)) {
        throw new Error(`Vertex embeddings returned ${vectors.length} vectors for ${input.texts.length} texts`);
      }
      return vectors;
    } catch (error) {
      lastError = error as Error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
  throw lastError ?? new Error("Vertex embeddings failed");
}
