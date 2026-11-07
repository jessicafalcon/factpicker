/**
 * Versioned stance evaluation.
 *
 *   npm run stance:eval
 *
 * Reads the cached model verdicts and writes, WITHOUT touching any existing
 * artifact:
 *
 *   data/analyses/runs/v1-exact/          the first acceptance rule (verbatim only)
 *   data/analyses/runs/v2-fuzzy/          verbatim + fuzzy sentence + listicle rule
 *   data/analyses/runs/comparison.json    both rules scored on the gold set
 *
 * "v1" is a reconstruction from data/analyses/.vertex-cache.json: the earlier
 * artifact was replaced in-place before run directories existed, so the labels
 * are recomputed from the cached verdicts with the v1 acceptance rule. No model
 * call is made.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { CANDIDATES, CANDIDATES_BY_ID } from "../supabase/functions/_shared/candidates.ts";
import { evidenceIsVerbatim } from "../supabase/functions/_shared/normalize.ts";
import { assessRelevance, matchEvidence } from "../supabase/functions/_shared/stance-quality.ts";
import { scoreVideoForCandidate } from "../supabase/functions/_shared/sentiment.ts";
import type { VideoRow } from "../supabase/functions/_shared/types.ts";
import { loadEnv, table } from "./lib.ts";

loadEnv();

const NEUTRAL_BAND = 0.15;
const DIR = "data/oriane";
const files = readFileSync("/dev/null", "utf8") === "" ? null : null; // keep import shape simple
void files;

const snapshot = JSON.parse(readFileSync("data/oriane/top10-all.json", "utf8"));
const videos = new Map<string, VideoRow>(snapshot.videos.map((video: VideoRow) => [video.id, video]));
const cache: Record<string, any> = JSON.parse(readFileSync("data/analyses/.vertex-cache.json", "utf8"));
const gold = JSON.parse(readFileSync("data/analyses/gold-stance.json", "utf8")).items as Array<any>;

// Rebuild the (video × candidate) pair list from the per-candidate files.
import { readdirSync } from "node:fs";
const candidateFiles = readdirSync(DIR).filter(
  (file) => file.endsWith(".json") && !file.startsWith("_") && file !== "top10-all.json",
);
const pairs: Array<{ video_id: string; candidate_id: string }> = [];
for (const file of candidateFiles) {
  const payload = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8"));
  const candidateId = payload.candidate.id;
  for (const video of payload.videos as VideoRow[]) {
    if (video.is_french) pairs.push({ video_id: video.id, candidate_id: candidateId });
  }
}
const uniquePairs = [...new Map(pairs.map((pair) => [`${pair.video_id}|${pair.candidate_id}`, pair])).values()];

function labelFromScore(score: number, unclear: boolean) {
  if (unclear) return "unclear";
  if (score >= NEUTRAL_BAND) return "favorable";
  if (score <= -NEUTRAL_BAND) return "critical";
  return "neutral";
}

interface Labelled {
  video_id: string;
  candidate_id: string;
  creator_handle: string;
  views: number | null;
  label: string;
  score: number;
  basis: string;
  evidence_mode: "exact" | "fuzzy" | "none";
  relevance: string;
  quote: string;
}

/** v1: accept a model verdict only when the quote is a verbatim substring. */
function labelV1(pair: { video_id: string; candidate_id: string }): Labelled {
  const video = videos.get(pair.video_id)!;
  const candidate = CANDIDATES_BY_ID[pair.candidate_id];
  const verdict = cache[`${pair.video_id}|${pair.candidate_id}`];
  const fallback = scoreVideoForCandidate(video, candidate, CANDIDATES);

  let score = fallback.score;
  let unclear = fallback.unclear;
  let basis: string = fallback.basis;
  let evidence_mode: Labelled["evidence_mode"] = "none";
  let quote = fallback.quote;

  if (verdict && verdict.stance !== "unclear") {
    const haystacks = [
      video.caption ?? "",
      (video.on_screen_text ?? []).join("\n"),
      video.transcript ?? "",
    ];
    const exact = haystacks.some((text) => evidenceIsVerbatim(verdict.evidence_quote, text));
    if (exact) {
      score = verdict.score;
      unclear = false;
      basis = "gemini:exact";
      evidence_mode = "exact";
      quote = verdict.evidence_quote;
    } else {
      score = 0;
      unclear = true;
      basis = "gemini:unverified";
    }
  }

  return {
    video_id: pair.video_id,
    candidate_id: pair.candidate_id,
    creator_handle: video.creator_handle ?? "unknown",
    views: video.views,
    label: labelFromScore(score, unclear),
    score,
    basis,
    evidence_mode,
    relevance: assessRelevance(video, candidate).kind,
    quote,
  };
}

/** v2: verbatim, then fuzzy sentence match, then relevance rules. */
function labelV2(pair: { video_id: string; candidate_id: string }): Labelled {
  const video = videos.get(pair.video_id)!;
  const candidate = CANDIDATES_BY_ID[pair.candidate_id];
  const verdict = cache[`${pair.video_id}|${pair.candidate_id}`];
  const fallback = scoreVideoForCandidate(video, candidate, CANDIDATES);
  const relevance = assessRelevance(video, candidate).kind;
  const evidence = verdict ? matchEvidence(verdict.evidence_quote, video) : null;

  const base = {
    video_id: pair.video_id,
    candidate_id: pair.candidate_id,
    creator_handle: video.creator_handle ?? "unknown",
    views: video.views,
  };

  // Relevance gates first: a namesake or an absent candidate cannot carry a
  // stance, however confident the model is.
  if (relevance === "absent" || relevance === "namesake_risk") {
    return { ...base, label: "unclear", score: 0, basis: `relevance:${relevance}`, evidence_mode: "none", relevance, quote: "" };
  }
  if (relevance === "listicle" && !(verdict && verdict.stance !== "unclear" && evidence?.verified)) {
    return { ...base, label: "neutral", score: 0, basis: "relevance:listicle", evidence_mode: "none", relevance, quote: "" };
  }
  if (verdict && verdict.stance !== "unclear" && evidence?.verified) {
    return {
      ...base,
      label: labelFromScore(verdict.score, false),
      score: verdict.score,
      basis: `gemini:${evidence.mode}`,
      evidence_mode: evidence.mode,
      relevance,
      quote: evidence.sentence ?? verdict.evidence_quote,
    };
  }
  if (verdict && verdict.stance !== "unclear") {
    return { ...base, label: "unclear", score: 0, basis: "gemini:unverified", evidence_mode: "none", relevance, quote: "" };
  }
  return {
    ...base,
    label: labelFromScore(fallback.score, fallback.unclear),
    score: fallback.score,
    basis: fallback.basis,
    evidence_mode: "none",
    relevance,
    quote: fallback.quote,
  };
}

function summarise(rows: Labelled[]) {
  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.label] = (acc[row.label] ?? 0) + 1;
    return acc;
  }, {});
  return {
    pairs: rows.length,
    favorable: counts.favorable ?? 0,
    critical: counts.critical ?? 0,
    neutral: counts.neutral ?? 0,
    unclear: counts.unclear ?? 0,
    decisive: rows.length - (counts.unclear ?? 0),
    coverage: Number(((rows.length - (counts.unclear ?? 0)) / rows.length).toFixed(3)),
    evidence: rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.evidence_mode] = (acc[row.evidence_mode] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

function evaluate(name: string, rows: Labelled[]) {
  const byKey = new Map(rows.map((row) => [`${row.video_id}|${row.candidate_id}`, row]));
  const reduce = (label: string) =>
    label === "favorable" || label === "critical" ? label : "no_stance";
  let correct = 0;
  let goldStance = 0;
  let hit = 0;
  let predictedStance = 0;
  let falseStance = 0;
  const rowsOut: Array<Record<string, unknown>> = [];
  for (const item of gold) {
    const row = byKey.get(`${item.video_id}|${item.candidate_id}`);
    const predicted = row?.label ?? "unclear";
    const goldClass = reduce(item.label);
    const predClass = reduce(predicted);
    const ok = goldClass === predClass;
    if (ok) correct++;
    if (goldClass !== "no_stance") {
      goldStance++;
      if (predClass === goldClass) hit++;
    }
    if (predClass !== "no_stance") {
      predictedStance++;
      if (goldClass === "no_stance") falseStance++;
    }
    rowsOut.push({ n: item.n, candidate: item.candidate_id, gold: item.label, pred: predicted, ok });
  }
  return {
    rule: name,
    agreement: Number((correct / gold.length).toFixed(3)),
    stanceRecall: goldStance ? Number((hit / goldStance).toFixed(3)) : 0,
    stancePrecision: predictedStance ? Number((1 - falseStance / predictedStance).toFixed(3)) : 0,
    falseStance,
    rows: rowsOut,
  };
}

const v1 = uniquePairs.map(labelV1);
const v2 = uniquePairs.map(labelV2);

mkdirSync("data/analyses/runs/v1-exact", { recursive: true });
mkdirSync("data/analyses/runs/v2-fuzzy", { recursive: true });

writeFileSync("data/analyses/runs/v1-exact/labels.json", JSON.stringify({ rule: "v1-exact", rows: v1 }, null, 2));
writeFileSync("data/analyses/runs/v2-fuzzy/labels.json", JSON.stringify({ rule: "v2-fuzzy", rows: v2 }, null, 2));

const comparison = {
  generatedAt: new Date().toISOString(),
  note: "v1 is reconstructed from .vertex-cache.json with the verbatim-only rule; the original artifact was replaced before run directories existed.",
  summary: { v1: summarise(v1), v2: summarise(v2) },
  gold: { size: gold.length, evaluation: [evaluate("v1-exact", v1), evaluate("v2-fuzzy", v2)] },
};
writeFileSync("data/analyses/runs/comparison.json", JSON.stringify(comparison, null, 2));

console.log("Rule comparison over 273 pairs:");
console.log(
  table([
    { rule: "v1-exact", ...comparison.summary.v1, evidence: JSON.stringify(comparison.summary.v1.evidence) },
    { rule: "v2-fuzzy", ...comparison.summary.v2, evidence: JSON.stringify(comparison.summary.v2.evidence) },
  ].map(({ evidence, ...rest }) => ({ ...rest, exact: JSON.parse(evidence).exact ?? 0, fuzzy: JSON.parse(evidence).fuzzy ?? 0 }))),
);

console.log("\nAgainst the 24-video gold set:");
console.log(
  table(
    comparison.gold.evaluation.map((entry) => ({
      rule: entry.rule,
      agreement: entry.agreement,
      stance_recall: entry.stanceRecall,
      stance_precision: entry.stancePrecision,
      false_stance: entry.falseStance,
    })),
  ),
);
console.log("\nWrote data/analyses/runs/{v1-exact,v2-fuzzy}/labels.json and runs/comparison.json");
