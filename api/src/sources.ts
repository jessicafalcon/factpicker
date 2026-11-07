/**
 * Data sources for the Factpicker API.
 *
 * Every resolver reads through a `Dataset`, so swapping the local artifact
 * files for Supabase / BigQuery / Vertex changes one factory call and nothing
 * else. That is the composability the app pages need.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANDIDATES } from "../../supabase/functions/_shared/candidates.ts";
import type { CandidateDef, VideoRow } from "../../supabase/functions/_shared/types.ts";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const repoPath = (...parts: string[]) => join(REPO_ROOT, ...parts);

export interface StanceRow {
  video_id: string;
  candidate_id: string;
  creator_handle?: string;
  score: number;
  label: "favorable" | "critical" | "neutral" | "unclear";
  basis: string;
  evidence_mode: "exact" | "fuzzy" | "none";
  relevance?: string;
  quote: string;
  markers?: string[];
}

export interface FactDef {
  id: string;
  statement: string;
  category: string;
  anchorTerms: string[];
  topicIds: string[];
  eventIds: string[];
  sourceName: string | null;
  sourceUrl: string | null;
  reviewStatus: string;
  verified: boolean;
}

export interface EventsDoc {
  generatedAt: string;
  window: { first: string; last: string };
  summary: Record<string, unknown>;
  issue_groups: Array<{ major_issue: string; videos: number; sub_issues: Array<{ sub_issue: string; videos: number; topics: any[]; events: any[] }> }>;
  events: any[];
  scandals: any[];
  topics: any[];
  candidate_topic_matrix: any[];
}

export interface Dataset {
  candidates: CandidateDef[];
  videos: VideoRow[];
  stance: StanceRow[];
  events: EventsDoc;
  facts: FactDef[];
  timeline: any | null;
  origin: { videos: string; stance: string; events: string; facts: string };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));

function pickFirst(paths: string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null;
}

/** Local artifact dataset. This is the default and the one used by tests. */
export function loadFromArtifacts(): Dataset {
  const videosPath = repoPath("data/oriane/top10-all.json");
  const stancePath = pickFirst([
    repoPath("data/analyses/runs/v2-fuzzy/candidate-stance.json"),
    repoPath("data/analyses/candidate-stance.json"),
  ]);
  const eventsPath = repoPath("data/analyses/events.json");
  const factsPath = pickFirst([repoPath("api/data/facts.json"), repoPath("data/analyses/facts.json")]);
  const timelinePath = pickFirst([repoPath("data/analyses/timeline-stats.json")]);

  if (!existsSync(videosPath)) throw new Error(`missing video snapshot at ${videosPath}`);
  if (!stancePath) throw new Error("missing stance artifact — run `npm run stance:candidates`");
  if (!existsSync(eventsPath)) throw new Error("missing events artifact — run `npm run events`");
  if (!factsPath) throw new Error("missing fact catalog at api/data/facts.json");

  const videoDoc = readJson<{ videos: VideoRow[] }>(videosPath);
  const stanceDoc = readJson<{ videos: StanceRow[] }>(stancePath);

  return {
    candidates: CANDIDATES,
    videos: videoDoc.videos,
    stance: stanceDoc.videos,
    events: readJson<EventsDoc>(eventsPath),
    facts: readJson<FactDef[]>(factsPath),
    timeline: timelinePath ? readJson(timelinePath) : null,
    origin: {
      videos: videosPath.replace(REPO_ROOT + "/", ""),
      stance: stancePath.replace(REPO_ROOT + "/", ""),
      events: eventsPath.replace(REPO_ROOT + "/", ""),
      facts: factsPath.replace(REPO_ROOT + "/", ""),
    },
  };
}

/**
 * Supabase-backed dataset. Videos and per-video stance come from Postgres via
 * PostgREST; events and the fact catalog stay file-backed in v0.1 because they
 * are generated artifacts, not user-edited tables.
 */
export async function loadFromSupabase(
  url: string,
  key: string,
  options: { timeoutMs?: number } = {},
): Promise<Dataset> {
  const base = loadFromArtifacts();
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const fetchTable = async (table: string, select: string): Promise<any[]> => {
    const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${table}?select=${encodeURIComponent(select)}&limit=5000`, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) throw new Error(`supabase ${table}: ${response.status} ${await response.text()}`);
    return (await response.json()) as any[];
  };

  const [videos, stance] = await Promise.all([
    fetchTable("videos", "*"),
    fetchTable("video_stance", "*"),
  ]);
  if (videos.length === 0) throw new Error("supabase returned no videos");
  return {
    ...base,
    videos: videos as VideoRow[],
    stance: stance as StanceRow[],
    origin: { ...base.origin, videos: `supabase:${url}`, stance: `supabase:${url}` },
  };
}

/** Build the dataset from env, preferring Supabase when it is configured. */
export async function createDataset(env: Record<string, string | undefined> = process.env): Promise<Dataset> {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || env.DATABASE_API;
  if (url && key) {
    try {
      return await loadFromSupabase(url, key);
    } catch (error) {
      console.warn(`[api] supabase unavailable, falling back to artifacts: ${(error as Error).message}`);
    }
  }
  return loadFromArtifacts();
}

// ── Vertex AI embeddings ──────────────────────────────────────────────────
export interface EmbeddingClient {
  available: boolean;
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

async function accessToken(env: Record<string, string | undefined>): Promise<string | null> {
  if (env.GOOGLE_ACCESS_TOKEN) return env.GOOGLE_ACCESS_TOKEN;
  try {
    const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    return ((await response.json()) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

const EMBED_DIMS = 3072;
const hashEmbedding = (text: string): number[] => {
  // Deterministic offline fallback so the lexical path is testable and the
  // service degrades instead of failing when Vertex is not configured.
  const vector = new Array(EMBED_DIMS).fill(0);
  for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % EMBED_DIMS;
    vector[index] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
};

export function createEmbeddingClient(env: Record<string, string | undefined> = process.env): EmbeddingClient {
  const project = env.GCP_PROJECT;
  const location = env.VERTEX_LOCATION ?? "us-central1";
  const model = env.VERTEX_EMBEDDING_MODEL ?? "gemini-embedding-001";
  const cachePath = repoPath("api/.cache/embeddings.json");
  let cache: Record<string, number[]> = {};
  if (existsSync(cachePath)) {
    try {
      cache = readJson(cachePath);
    } catch {
      cache = {};
    }
  }
  const persist = () => {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache));
  };

  return {
    available: Boolean(project && env.VERTEX_EMBEDDINGS === "1"),
    model,
    async embed(texts: string[]): Promise<number[][]> {
      if (!project || env.VERTEX_EMBEDDINGS !== "1") return texts.map(hashEmbedding);
      const token = await accessToken(env);
      if (!token) return texts.map(hashEmbedding);

      const out: number[][] = [];
      for (let index = 0; index < texts.length; index += 5) {
        const batch = texts.slice(index, index + 5);
        const missing = batch.filter((text) => !cache[createHash("sha256").update(`${model}|${text}`).digest("hex")]);
        if (missing.length > 0) {
          const response = await fetch(
            `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ instances: missing.map((content) => ({ content })) }),
              signal: AbortSignal.timeout(20_000),
            },
          );
          if (!response.ok) throw new Error(`vertex embeddings: ${response.status} ${await response.text()}`);
          const payload = (await response.json()) as { predictions?: Array<{ embeddings?: { values?: number[] } }> };
          missing.forEach((text, position) => {
            const values = payload.predictions?.[position]?.embeddings?.values;
            if (values) cache[createHash("sha256").update(`${model}|${text}`).digest("hex")] = values;
          });
          persist();
        }
        for (const text of batch) {
          out.push(cache[createHash("sha256").update(`${model}|${text}`).digest("hex")] ?? hashEmbedding(text));
        }
      }
      return out;
    },
  };
}
