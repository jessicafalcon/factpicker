/**
 * Candidate-level stance and metrics over the per-candidate snapshot.
 *
 *   npm run stance:candidates                 # Gemini, batched one call per video
 *   npm run stance:candidates -- --dry-run    # deterministic only, no model calls
 *   npm run stance:candidates -- --max-calls 50
 *
 * Input : data/oriane/<candidate>.json  (the top videos pulled for each candidate)
 * Output: data/analyses/candidate-stance.json
 *         data/analyses/stance-videos.csv
 *         data/analyses/stance-creators.csv
 *
 * Every video described for a candidate is scored toward THAT candidate, whether
 * or not the name appears in the text (the flag `own_mention` records which).
 *
 * Cost: one model call per unique video (~209), not per pair (~305), and the
 * call is skipped entirely with --dry-run or when the deterministic score is
 * already decisive and unambiguous.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { CANDIDATES, CANDIDATES_BY_ID } from "../supabase/functions/_shared/candidates.ts";
import {
  scoreVideoForCandidate,
  type StanceLabel,
} from "../supabase/functions/_shared/sentiment.ts";
import { classifyStancesBatch, getAccessToken, type BatchStance } from "../supabase/functions/_shared/vertex.ts";
import { assessRelevance, matchEvidence } from "../supabase/functions/_shared/stance-quality.ts";
import { mapWithConcurrency } from "../supabase/functions/_shared/analyze.ts";
import type { CandidateDef, VideoRow } from "../supabase/functions/_shared/types.ts";
import { loadEnv, num, parseArgs, table } from "./lib.ts";

loadEnv();
const args = parseArgs(process.argv.slice(2));

const dryRun = args["dry-run"] === true;
const maxCalls = num(args["max-calls"], 220);
const concurrency = num(args.concurrency, 6);
const model = String(args.model ?? process.env.VERTEX_MODEL ?? "gemini-2.5-flash");
const location = String(args.location ?? process.env.VERTEX_LOCATION ?? "us-central1");
const project = String(args.project ?? process.env.GCP_PROJECT ?? "");
const NEUTRAL_BAND = 0.15;
// Versioned output: promoting to data/analyses/ is an explicit choice, so a
// re-run never silently replaces a previous artifact.
const OUT_DIR = String(args["out-dir"] ?? "data/analyses/runs/v2-fuzzy");
const MIN_VIDEOS = 2;

interface Pair {
  video_id: string;
  candidate_id: string;
  own_mention: boolean;
}

interface ScoredPair {
  video_id: string;
  candidate_id: string;
  creator_handle: string;
  creator_display_name: string | null;
  creator_followers: number | null;
  platform: string;
  platform_format: string | null;
  format: string;
  posted_at: string | null;
  views: number | null;
  interactions: number | null;
  url: string;
  own_mention: boolean;
  relevance: "direct" | "listicle" | "credit_ocr" | "namesake_risk" | "absent";
  evidence_mode: "exact" | "fuzzy" | "none";
  score: number;
  label: "favorable" | "critical" | "neutral" | "unclear";
  basis: string;
  markers: string[];
  quote: string;
  gemini: null | { stance: string; score: number; evidence_verified: boolean; evidence_source: string | null; rationale: string };
}

// ── Load the per-candidate snapshot ───────────────────────────────────────
const dir = "data/oriane";
const files = readdirSync(dir).filter(
  (file) => file.endsWith(".json") && !file.startsWith("_") && file !== "top10-all.json",
);

const CACHE_PATH = "data/analyses/.vertex-cache.json";
let cache: Record<string, BatchStance> = {};
try {
  cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
} catch {
  cache = {};
}

const videos = new Map<string, VideoRow>();
const pairs: Pair[] = [];
const candidateOrder: string[] = [];

for (const file of files) {
  const payload = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
  const candidateId: string = payload.candidate.id;
  if (!CANDIDATES_BY_ID[candidateId]) continue;
  candidateOrder.push(candidateId);

  const ownVideos = new Set(
    payload.mentions.filter((mention: any) => mention.candidate_id === candidateId).map((mention: any) => mention.video_id),
  );

  for (const video of payload.videos as VideoRow[]) {
    if (!video.is_french) continue;
    videos.set(video.id, video);
    pairs.push({ video_id: video.id, candidate_id: candidateId, own_mention: ownVideos.has(video.id) });
  }
}

const uniquePairs = [...new Map(pairs.map((pair) => [`${pair.video_id}|${pair.candidate_id}`, pair])).values()];
const candidates = CANDIDATES.filter((candidate) => candidateOrder.includes(candidate.id));
const videosById = new Map(videos);
const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));

console.log(
  `${files.length} candidate files → ${videosById.size} unique French videos → ${uniquePairs.length} (video × candidate) pairs`,
);

// ── Deterministic pass ────────────────────────────────────────────────────
const deterministic = new Map<string, ReturnType<typeof scoreVideoForCandidate>>();
for (const pair of uniquePairs) {
  const video = videosById.get(pair.video_id)!;
  const candidate = candidatesById.get(pair.candidate_id)!;
  deterministic.set(`${pair.video_id}|${pair.candidate_id}`, scoreVideoForCandidate(video, candidate, candidates));
}

// Group targets by video so one call covers every candidate in that post.
const targetsByVideo = new Map<string, CandidateDef[]>();
for (const pair of uniquePairs) {
  const list = targetsByVideo.get(pair.video_id) ?? [];
  const candidate = candidatesById.get(pair.candidate_id);
  if (candidate) list.push(candidate);
  targetsByVideo.set(pair.video_id, list);
}

// ── Gemini pass (batched) ─────────────────────────────────────────────────
const gemini = new Map<string, BatchStance>();
let calls = 0;
let failures = 0;

if (!dryRun) {
  if (!project) throw new Error("Set GCP_PROJECT or pass --project");
  const missing = [...targetsByVideo.entries()]
    .map(([videoId, targets]): [string, CandidateDef[]] => [
      videoId,
      targets.filter((candidate) => !cache[`${videoId}|${candidate.id}`]),
    ])
    .filter(([, targets]) => targets.length > 0);
  const work = missing.slice(0, maxCalls);
  console.log(`Cache: ${Object.keys(cache).length} verdict(s) reused, ${work.length} call(s) to make`);
  // Only mint credentials when a call is actually needed.
  const accessToken = work.length > 0 ? await getAccessToken() : "";

  await mapWithConcurrency(work, concurrency, async ([videoId, targets]) => {
    const video = videosById.get(videoId)!;
    try {
      const results = await classifyStancesBatch({
        video,
        targets: targets.map((candidate) => ({ id: candidate.id, name: candidate.name })),
        config: { project, location, model, accessToken },
      });
      calls++;
      for (const result of results) {
        const key = `${videoId}|${result.candidate_id}`;
        cache[key] = result;
        gemini.set(key, result);
      }
    } catch (error) {
      failures++;
      console.warn(`  ! ${videoId}: ${(error as Error).message.slice(0, 120)}`);
    }
  });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log(`Gemini: ${calls} call(s), ${failures} failure(s), ${Object.keys(cache).length} cached verdicts`);
} else {
  console.log("Dry run: deterministic pass only, no model calls.");
}

// ── Merge ─────────────────────────────────────────────────────────────────
function labelFor(score: number, unclear: boolean): ScoredPair["label"] {
  if (unclear) return "unclear";
  if (score >= NEUTRAL_BAND) return "favorable";
  if (score <= -NEUTRAL_BAND) return "critical";
  return "neutral";
}

// Hydrate verdicts from the cache so re-runs and re-merges cost nothing.
for (const [key, value] of Object.entries(cache)) gemini.set(key, value);

const scored: ScoredPair[] = uniquePairs.map((pair) => {
  const key = `${pair.video_id}|${pair.candidate_id}`;
  const video = videosById.get(pair.video_id)!;
  const base = deterministic.get(key)!;
  const modelResult = gemini.get(key);

  const candidateDef = candidatesById.get(pair.candidate_id)!;
  const relevance = assessRelevance(video, candidateDef).kind;

  // Evidence contract, v2: verbatim first, then a sentence-level fuzzy match.
  // The fuzzy path still returns a real substring of the source, so no label
  // ever rests on invented text; the mode is stored for the UI.
  const evidence = modelResult ? matchEvidence(modelResult.evidence_quote, video) : null;
  const modelStance = modelResult?.stance;
  const modelUsable = Boolean(modelResult && modelStance !== "unclear" && evidence?.verified);
  const modelRejected = Boolean(modelResult && modelStance !== "unclear" && !evidence?.verified);

  let score: number;
  let unclear: boolean;
  let basis: string;

  if (relevance === "absent" || relevance === "namesake_risk") {
    score = 0;
    unclear = true;
    basis = relevance === "absent" ? "relevance:absent" : "relevance:namesake_risk";
  } else if (modelUsable) {
    score = modelResult!.score;
    unclear = false;
    basis = `gemini:${model}:${evidence!.mode}`;
  } else if (relevance === "listicle" && !modelUsable) {
    // A row in a list of declared candidates is neutral coverage, not "unclear".
    score = 0;
    unclear = false;
    basis = "relevance:listicle";
  } else if (modelRejected) {
    score = 0;
    unclear = true;
    basis = evidence && evidence.similarity > 0.4 ? `gemini:${model}:unverified` : "none";
  } else {
    score = base.score;
    unclear = base.unclear;
    basis = base.basis;
  }

  // A rule-assigned neutral is not "unclear", so label it explicitly below.
  if (basis === "relevance:listicle") {
    return {
      video_id: video.id,
      candidate_id: pair.candidate_id,
      creator_handle: video.creator_handle ?? "unknown",
      creator_display_name: video.creator_display_name ?? null,
      creator_followers: video.creator_followers ?? null,
      platform: video.platform,
      platform_format: video.platform_format ?? null,
      format: video.format,
      posted_at: video.posted_at,
      views: video.views,
      interactions: video.interactions,
      url: video.url,
      own_mention: pair.own_mention,
      relevance,
      evidence_mode: "none",
      score: 0,
      label: "neutral",
      basis,
      markers: [],
      quote: "",
      gemini: modelResult
        ? {
            stance: modelResult.stance,
            score: modelResult.score,
            evidence_verified: Boolean(evidence?.verified),
            evidence_source: evidence?.source ?? null,
            rationale: modelResult.rationale,
          }
        : null,
    };
  }

  return {
    video_id: video.id,
    candidate_id: pair.candidate_id,
    creator_handle: video.creator_handle ?? "unknown",
    creator_display_name: video.creator_display_name ?? null,
    creator_followers: video.creator_followers ?? null,
    platform: video.platform,
    platform_format: video.platform_format ?? null,
    format: video.format,
    posted_at: video.posted_at,
    views: video.views,
    interactions: video.interactions,
    url: video.url,
    own_mention: pair.own_mention,
    relevance,
    evidence_mode: evidence?.mode ?? "none",
    score,
    label: labelFor(score, unclear),
    basis,
    markers: modelUsable ? [modelStance!] : base.markers.map((marker) => marker.term),
    quote: modelUsable ? evidence!.sentence ?? modelResult!.evidence_quote : base.quote,
    gemini: modelResult
      ? {
          stance: modelResult.stance,
          score: modelResult.score,
          evidence_verified: modelResult.evidence_verified,
          evidence_source: modelResult.evidence_source,
          rationale: modelResult.rationale,
        }
      : null,
  };
});

// ── Candidate metrics ─────────────────────────────────────────────────────
function candidateMetrics(candidate: CandidateDef) {
  const rows = scored.filter((row) => row.candidate_id === candidate.id);
  const videosCount = rows.length;
  const favorable = rows.filter((row) => row.label === "favorable").length;
  const critical = rows.filter((row) => row.label === "critical").length;
  const neutral = rows.filter((row) => row.label === "neutral").length;
  const unclear = rows.filter((row) => row.label === "unclear").length;
  const totalViews = rows.reduce((sum, row) => sum + (row.views ?? 0), 0);
  const weighted = rows.reduce((sum, row) => sum + row.score * (row.views ?? 0), 0);

  const evidence = rows
    .filter((row) => row.label !== "unclear" && row.quote)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 3)
    .map((row) => ({
      video_id: row.video_id,
      creator_handle: row.creator_handle,
      label: row.label,
      score: row.score,
      basis: row.basis,
      quote: row.quote,
    }));

  return {
    candidate_id: candidate.id,
    name: candidate.name,
    party: candidate.partyShort ?? candidate.party,
    tier: candidate.tier,
    status: candidate.status,
    videos: videosCount,
    with_own_mention: rows.filter((row) => row.own_mention).length,
    favorable,
    critical,
    neutral,
    unclear,
    coverage: videosCount ? Number(((videosCount - unclear) / videosCount).toFixed(3)) : 0,
    stance_index: videosCount ? Number(((favorable - critical) / videosCount).toFixed(3)) : 0,
    avg_score: videosCount
      ? Number((rows.reduce((sum, row) => sum + row.score, 0) / videosCount).toFixed(3))
      : 0,
    view_weighted_index: totalViews ? Number((weighted / totalViews).toFixed(3)) : 0,
    favorable_pct: videosCount ? Number(((100 * favorable) / videosCount).toFixed(1)) : 0,
    critical_pct: videosCount ? Number(((100 * critical) / videosCount).toFixed(1)) : 0,
    creators: new Set(rows.map((row) => row.creator_handle)).size,
    total_views: totalViews,
    avg_views: videosCount ? Math.round(totalViews / videosCount) : 0,
    formats: rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.format] = (acc[row.format] ?? 0) + 1;
      return acc;
    }, {}),
    platforms: rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.platform] = (acc[row.platform] ?? 0) + 1;
      return acc;
    }, {}),
    evidence,
  };
}

// ── Creator × candidate rollup ────────────────────────────────────────────
function creatorLabel(index: number, decisive: number, videosCount: number): StanceLabel {
  if (videosCount < MIN_VIDEOS) return "single_video";
  if (decisive === 0) return "no_signal";
  if (index >= 0.6) return "favorable";
  if (index >= 0.2) return "leaning_favorable";
  if (index <= -0.6) return "critical";
  if (index <= -0.2) return "leaning_critical";
  return "mixed";
}

const creatorMap = new Map<string, any>();
for (const row of scored) {
  const key = `${row.creator_handle}|${row.candidate_id}`;
  let entry = creatorMap.get(key);
  if (!entry) {
    entry = {
      creator_handle: row.creator_handle,
      creator_display_name: row.creator_display_name,
      creator_followers: row.creator_followers,
      candidate_id: row.candidate_id,
      videos: 0,
      favorable: 0,
      critical: 0,
      neutral: 0,
      unclear: 0,
      total_views: 0,
      _scoreSum: 0,
      _weighted: 0,
      evidence: [] as any[],
    };
    creatorMap.set(key, entry);
  }
  entry.videos += 1;
  entry.total_views += row.views ?? 0;
  entry._scoreSum += row.score;
  entry._weighted += row.score * (row.views ?? 0);
  if (row.label === "unclear") entry.unclear += 1;
  else entry[row.label] += 1;
  if (row.label !== "unclear" && entry.evidence.length < 3 && row.quote) {
    entry.evidence.push({ video_id: row.video_id, label: row.label, score: row.score, quote: row.quote, basis: row.basis });
  }
}

const creators = [...creatorMap.values()].map((entry) => {
  const decisive = entry.favorable + entry.critical + entry.neutral;
  const index = Number(((entry.favorable - entry.critical) / Math.max(entry.videos, 1)).toFixed(3));
  const record = {
    creator_handle: entry.creator_handle,
    creator_display_name: entry.creator_display_name,
    creator_followers: entry.creator_followers,
    candidate_id: entry.candidate_id,
    candidate_name: candidatesById.get(entry.candidate_id)?.name ?? entry.candidate_id,
    videos: entry.videos,
    favorable: entry.favorable,
    critical: entry.critical,
    neutral: entry.neutral,
    unclear: entry.unclear,
    stance_index: index,
    view_weighted_index: Number((entry._weighted / Math.max(entry.total_views, 1)).toFixed(3)),
    avg_score: Number((entry._scoreSum / Math.max(entry.videos, 1)).toFixed(3)),
    label: creatorLabel(index, decisive, entry.videos),
    total_views: entry.total_views,
    evidence: entry.evidence,
  };
  return record;
});

creators.sort((a, b) => Math.abs(b.stance_index) - Math.abs(a.stance_index) || b.videos - a.videos);

// ── Write ─────────────────────────────────────────────────────────────────
const candidateMetricsRows = candidates.map(candidateMetrics);
const result = {
  generatedAt: new Date().toISOString(),
  method: {
    model: dryRun ? null : model,
    location: dryRun ? null : location,
    batched: "one call per video",
    deterministic: "lexicon + sentence anchoring + coreference",
    neutralBand: NEUTRAL_BAND,
    minVideosForCreatorLabel: MIN_VIDEOS,
    pairs: uniquePairs.length,
    uniqueVideos: videosById.size,
    modelCalls: calls,
    modelFailures: failures,
    verdictsFromModel: [...scored].filter((row) => row.basis.startsWith("gemini")).length,
  },
  candidates: candidateMetricsRows,
  videos: scored,
  creators,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/candidate-stance.json`, JSON.stringify(result, null, 2));

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
};

writeFileSync(
  `${OUT_DIR}/stance-videos.csv`,
  [
    ["candidate_id", "video_id", "creator_handle", "platform", "posted_at", "views", "format", "label", "score", "basis", "markers", "quote", "own_mention", "evidence_verified", "url"].join(","),
    ...scored.map((row) =>
      [
        row.candidate_id, row.video_id, row.creator_handle, row.platform, row.posted_at, row.views,
        row.format, row.label, row.score, row.basis, row.markers.join("|"), row.quote,
        row.own_mention, row.gemini?.evidence_verified ?? false, row.url,
      ].map(csvCell).join(","),
    ),
  ].join("\n"),
);

writeFileSync(
  `${OUT_DIR}/stance-creators.csv`,
  [
    ["candidate_id", "candidate_name", "creator_handle", "videos", "favorable", "critical", "neutral", "unclear", "stance_index", "view_weighted_index", "avg_score", "label", "total_views"].join(","),
    ...creators.map((row) =>
      [
        row.candidate_id, row.candidate_name, row.creator_handle, row.videos, row.favorable,
        row.critical, row.neutral, row.unclear, row.stance_index, row.view_weighted_index,
        row.avg_score, row.label, row.total_views,
      ].map(csvCell).join(","),
    ),
  ].join("\n"),
);

// ── Report ────────────────────────────────────────────────────────────────
console.log("\nPer-candidate stance:");
console.log(
  table(
    candidateMetricsRows
      .slice()
      .sort((a, b) => Math.abs(b.stance_index) - Math.abs(a.stance_index))
      .map((row) => ({
        candidate: row.candidate_id,
        videos: row.videos,
        fav: row.favorable,
        crit: row.critical,
        neu: row.neutral,
        unclear: row.unclear,
        index: row.stance_index,
        coverage: row.coverage,
        creators: row.creators,
      })),
  ),
);

console.log(
  `\n${scored.length} video×candidate rows | ${creators.length} creator rows | ` +
    `${scored.filter((row) => row.label !== "unclear").length} decisive`,
);
console.log(`Wrote ${OUT_DIR}/candidate-stance.json + stance-{videos,creators}.csv`);
