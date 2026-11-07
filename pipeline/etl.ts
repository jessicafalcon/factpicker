/**
 * Creator × candidate stance ETL.
 *
 *   Extract  : videos + mentions (local JSON snapshot, or Supabase REST)
 *   Transform: deterministic lexicon stance, then Vertex AI only for the
 *              ambiguous videos (bounded by --max-vertex-calls)
 *   Load     : JSON file, Supabase table `creator_stance`, BigQuery table
 *
 * Runs unchanged as a Cloud Run job (`pipeline/Dockerfile`) and locally:
 *
 *   npm run stance -- --input data/oriane/top10-all.json
 *   npm run stance -- --vertex --max-vertex-calls 5
 *
 * Cost discipline: zero Oriane calls, zero model calls unless escalation is
 * explicitly enabled and bounded.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { CANDIDATES } from "../supabase/functions/_shared/candidates.ts";
import {
  aggregateCreatorStance,
  describeStance,
  type CreatorCandidateStance,
  type StanceOverride,
} from "../supabase/functions/_shared/sentiment.ts";
import { classifyStance, getAccessToken, shouldEscalate } from "../supabase/functions/_shared/vertex.ts";
import { createSupabaseStore } from "../supabase/functions/_shared/store.ts";
import type { CandidateDef, VideoRow } from "../supabase/functions/_shared/types.ts";

type Env = Record<string, string | undefined>;

function env(key: string): string | undefined {
  const deno = (globalThis as any).Deno;
  if (deno?.env?.get) return deno.env.get(key) ?? undefined;
  return (globalThis as any).process?.env?.[key];
}

export interface EtlOptions {
  input?: string;
  out: string;
  maxVertexCalls: number;
  minVideos: number;
  neutralBand: number;
  writeSupabase: boolean;
  writeBigQuery: boolean;
  project?: string;
  location: string;
  model: string;
  verbose?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface EtlResult {
  generatedAt: string;
  params: Record<string, unknown>;
  stats: Record<string, unknown>;
  rows: CreatorCandidateStance[];
  perVideo: unknown[];
  escalations: Array<{ video_id: string; candidate_id: string; reason: string; stance?: string }>;
  creatorTotals: Array<Record<string, unknown>>;
}

interface MentionLite {
  video_id: string;
  candidate_id: string;
  strength: string;
}

export async function runEtl(options: EtlOptions, environment: Env = {} as Env): Promise<EtlResult> {
  const startedAt = Date.now();
  const log = (message: string) => {
    if (options.verbose) console.log(message);
  };

  // ── Extract ────────────────────────────────────────────────────────────
  let videos: VideoRow[];
  let mentions: MentionLite[];
  let candidateIds: string[];

  if (options.input) {
    const snapshot = JSON.parse(readFileSync(options.input, "utf8"));
    videos = snapshot.videos ?? [];
    mentions = snapshot.mentions ?? [];
    candidateIds = (snapshot.candidates ?? []).map((candidate: any) => candidate.id);
    log(`Extracted ${videos.length} videos and ${mentions.length} mentions from ${options.input}`);
  } else {
    const url = env("SUPABASE_URL");
    const key = env("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("Set --input <file> or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
    const store = createSupabaseStore({ url, serviceRoleKey: key });
    videos = await store.select<VideoRow>("videos", "select=*&limit=5000");
    mentions = await store.select<MentionLite>("mentions", "select=video_id,candidate_id,strength&limit=20000");
    candidateIds = [...new Set(mentions.map((mention) => mention.candidate_id))];
    log(`Extracted ${videos.length} videos and ${mentions.length} mentions from Supabase`);
  }

  const candidates: CandidateDef[] = CANDIDATES.filter((candidate) =>
    candidateIds.length ? candidateIds.includes(candidate.id) : true,
  );
  if (candidates.length === 0) throw new Error("No known candidates in the extracted mentions");

  // ── Transform: deterministic pass ──────────────────────────────────────
  const videosById = new Map(videos.map((video) => [video.id, video]));
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  const first = aggregateCreatorStance(videos, mentions, candidates, {
    minVideos: options.minVideos,
    neutralBand: options.neutralBand,
    onProgress: options.onProgress,
  });
  log(`Deterministic pass: ${first.perVideo.length} video×candidate scores`);

  // ── Transform: bounded Vertex escalation ───────────────────────────────
  const overrides = new Map<string, StanceOverride>();
  const escalations: EtlResult["escalations"] = [];
  let modelCalls = 0;
  let escalationsSkipped = 0;
  let consecutiveErrors = 0;

  if (options.maxVertexCalls > 0) {
    const project = options.project ?? env("GCP_PROJECT") ?? env("GOOGLE_CLOUD_PROJECT");
    if (!project) throw new Error("Vertex escalation needs --project or GCP_PROJECT");
    const accessToken = await getAccessToken();

    for (const row of first.perVideo) {
      // Errors count against the budget too, otherwise a bad model id or a
      // missing permission turns into hundreds of failed calls.
      if (modelCalls + escalationsSkipped >= options.maxVertexCalls) break;
      if (consecutiveErrors >= 3) break;
      const decision = shouldEscalate({
        unclear: row.unclear,
        positive: row.positive,
        negative: row.negative,
      });
      if (!decision.escalate) continue;

      const video = videosById.get(row.video_id);
      const candidate = candidatesById.get(row.candidate_id);
      if (!video || !candidate) continue;

      try {
        const result = await classifyStance({
          candidateName: candidate.name,
          handle: video.creator_handle ?? "unknown",
          video,
          deterministicScore: row.score,
          config: { project, location: options.location, model: options.model, accessToken },
        });
        modelCalls++;
        consecutiveErrors = 0;
        overrides.set(`${row.video_id}|${row.candidate_id}`, {
          score: result.score,
          basis: `vertex:${result.model}`,
          markers: [result.stance],
          quote: result.evidence_quote,
        });
        escalations.push({
          video_id: row.video_id,
          candidate_id: row.candidate_id,
          reason: decision.reason,
          stance: result.stance,
        });
      } catch (error) {
        escalationsSkipped++;
        consecutiveErrors++;
        escalations.push({
          video_id: row.video_id,
          candidate_id: row.candidate_id,
          reason: `error:${(error as Error).message.slice(0, 120)}`,
        });
      }
    }
    log(`Vertex: ${modelCalls} call(s), ${escalationsSkipped} error(s)`);
  }

  const final = overrides.size
    ? aggregateCreatorStance(videos, mentions, candidates, {
        minVideos: options.minVideos,
        neutralBand: options.neutralBand,
        overrides,
        onProgress: options.onProgress,
      })
    : first;

  // ── Creator-level totals (all candidates) ──────────────────────────────
  const totals = new Map<string, { favorable: number; critical: number; neutral: number; videos: number; candidates: Set<string> }>();
  for (const row of final.rows) {
    const entry = totals.get(row.creator_handle) ?? { favorable: 0, critical: 0, neutral: 0, videos: 0, candidates: new Set<string>() };
    entry.favorable += row.favorable;
    entry.critical += row.critical;
    entry.neutral += row.neutral;
    entry.videos += row.videos;
    entry.candidates.add(row.candidate_id);
    totals.set(row.creator_handle, entry);
  }

  const creatorTotals = [...totals.entries()]
    .map(([handle, entry]) => ({
      creator_handle: handle,
      videos: entry.videos,
      favorable: entry.favorable,
      critical: entry.critical,
      neutral: entry.neutral,
      candidates: [...entry.candidates],
      net: entry.favorable - entry.critical,
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  const result: EtlResult = {
    generatedAt: new Date().toISOString(),
    params: {
      input: options.input ?? "supabase",
      minVideos: options.minVideos,
      neutralBand: options.neutralBand,
      vertex: options.maxVertexCalls > 0 ? { project: options.project, location: options.location, model: options.model, maxCalls: options.maxVertexCalls } : null,
    },
    stats: {
      videos: videos.length,
      mentions: mentions.length,
      creators: new Set(videos.map((video) => video.creator_handle)).size,
      creatorCandidatePairs: final.rows.length,
      scoredPairs: final.perVideo.length,
      favorable: final.perVideo.filter((row) => !row.unclear && row.score >= options.neutralBand).length,
      critical: final.perVideo.filter((row) => !row.unclear && row.score <= -options.neutralBand).length,
      neutral: final.perVideo.filter((row) => !row.unclear && Math.abs(row.score) < options.neutralBand).length,
      unclear: final.perVideo.filter((row) => row.unclear).length,
      labels: final.rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.label] = (acc[row.label] ?? 0) + 1;
        return acc;
      }, {}),
      modelCalls,
      escalationErrors: escalationsSkipped,
      elapsedMs: Date.now() - startedAt,
    },
    rows: final.rows,
    perVideo: final.perVideo,
    escalations,
    creatorTotals,
  };

  // ── Load ───────────────────────────────────────────────────────────────
  mkdirSync(options.out.slice(0, options.out.lastIndexOf("/")) || ".", { recursive: true });
  writeFileSync(options.out, JSON.stringify(result, null, 2));
  log(`Wrote ${options.out} (${final.rows.length} rows)`);

  if (options.writeSupabase) {
    const url = env("SUPABASE_URL");
    const key = env("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("writeSupabase requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
    const store = createSupabaseStore({ url, serviceRoleKey: key });
    const rows = final.rows.map((row) => ({
      ...row,
      evidence: row.evidence,
      computed_at: new Date().toISOString(),
    }));
    const written = await store.upsert("creator_stance", rows, "creator_handle,candidate_id");
    log(`Supabase: ${written} creator_stance rows upserted`);
  }

  if (options.writeBigQuery) {
    const project = options.project ?? env("GCP_PROJECT") ?? env("GOOGLE_CLOUD_PROJECT");
    const dataset = env("BQ_DATASET") ?? "cadrage2027";
    if (!project) throw new Error("writeBigQuery requires --project or GCP_PROJECT");
    const token = await getAccessToken();
    const rows = final.rows.map((row) => ({
      json: {
        creator_handle: row.creator_handle,
        candidate_id: row.candidate_id,
        videos: row.videos,
        favorable: row.favorable,
        critical: row.critical,
        neutral: row.neutral,
        unclear: row.unclear,
        stance_index: row.stance_index,
        view_weighted_index: row.view_weighted_index,
        avg_score: row.avg_score,
        label: row.label,
        total_views: row.total_views,
        computed_at: new Date().toISOString(),
      },
    }));
    const endpoint =
      `https://bigquery.googleapis.com/bigquery/v2/projects/${project}` +
      `/datasets/${dataset}/tables/creator_stance/insertAll`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    if (!response.ok) throw new Error(`BigQuery insertAll ${response.status}: ${(await response.text()).slice(0, 300)}`);
    log(`BigQuery: ${rows.length} rows streamed to ${project}.${dataset}.creator_stance`);
  }

  return result;
}
