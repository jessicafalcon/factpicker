/**
 * Stance ablation on a hand-labelled gold set.
 *
 *   npm run stance:ablation                 # all four configs
 *   npm run stance:ablation -- --only embeddings,dry
 *
 * A  baseline      zero-shot gemini-2.5-flash (cached verdicts, no calls)
 * B  few-shot      gemini-2.5-flash + 6 French exemplars + relevance hint
 * C  pro           gemini-2.5-pro zero-shot (thinking enabled)
 * D  embeddings    gemini-embedding-001 nearest-anchor, no LLM
 *
 * Writes data/analyses/stance-ablation.json. Cost: ~18 flash + ~18 pro calls
 * (~$0.15) plus a few embedding calls, all cached per run in the output file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CANDIDATES, CANDIDATES_BY_ID } from "../supabase/functions/_shared/candidates.ts";
import { classifyStancesBatch, getAccessToken, type BatchStance } from "../supabase/functions/_shared/vertex.ts";
import { anchorClassify, embedTexts, STANCE_ANCHORS, cosine } from "../supabase/functions/_shared/embeddings.ts";
import { assessRelevance, matchEvidence } from "../supabase/functions/_shared/stance-quality.ts";
import { mapWithConcurrency } from "../supabase/functions/_shared/analyze.ts";
import type { VideoRow } from "../supabase/functions/_shared/types.ts";
import { loadEnv, parseArgs, table } from "./lib.ts";

loadEnv();
const args = parseArgs(process.argv.slice(2));
const project = String(args.project ?? process.env.GCP_PROJECT ?? "");
if (!project) throw new Error("Set GCP_PROJECT (or pass --project) for Vertex AI calls.");
const location = String(args.location ?? process.env.VERTEX_LOCATION ?? "us-central1");
const only = args.only ? String(args.only).split(",") : ["baseline", "fewshot", "pro", "embeddings"];
const concurrency = Number(args.concurrency ?? 4);

const gold = JSON.parse(readFileSync("data/analyses/gold-stance.json", "utf8")).items as Array<{
  n: number;
  video_id: string;
  candidate_id: string;
  label: "favorable" | "critical" | "neutral" | "irrelevant" | "ambiguous";
  why: string;
  creator: string;
}>;

const snapshot = JSON.parse(readFileSync("data/oriane/top10-all.json", "utf8"));
const videos = new Map<string, VideoRow>(snapshot.videos.map((video: VideoRow) => [video.id, video]));
const baselineArtifact = JSON.parse(readFileSync("data/analyses/candidate-stance.json", "utf8"));
const baselineByKey = new Map<string, any>(
  baselineArtifact.videos.map((row: any) => [`${row.video_id}|${row.candidate_id}`, row]),
);

// Group gold items by video so one model call covers every candidate in it.
const byVideo = new Map<string, typeof gold>();
for (const item of gold) {
  const list = byVideo.get(item.video_id) ?? [];
  list.push(item);
  byVideo.set(item.video_id, list);
}

// ── Relevance gate (no model calls) ──────────────────────────────────────
function relevanceClass(kind: string): "stance_possible" | "neutral_only" | "irrelevant" {
  if (kind === "listicle") return "neutral_only";
  if (kind === "absent" || kind === "credit_ocr") return "irrelevant";
  return "stance_possible";
}

function goldRelevanceClass(label: string): "stance_possible" | "neutral_only" | "irrelevant" {
  if (label === "favorable" || label === "critical") return "stance_possible";
  if (label === "irrelevant") return "irrelevant";
  return "neutral_only";
}

function computeRelevanceRows() {
  const rows: Array<Record<string, unknown>> = [];
  const confusion: Record<string, Record<string, number>> = {};
  let correct = 0;
  for (const item of gold) {
    const video = videos.get(item.video_id)!;
    const relevance = assessRelevance(video, CANDIDATES_BY_ID[item.candidate_id]);
    const predicted = relevanceClass(relevance.kind);
    const goldClass = goldRelevanceClass(item.label);
    const ok = predicted === goldClass;
    if (ok) correct++;
    confusion[goldClass] ??= {};
    confusion[goldClass][predicted] = (confusion[goldClass][predicted] ?? 0) + 1;
    rows.push({ n: item.n, gold: item.label, goldClass, kind: relevance.kind, predicted, candidatesInText: relevance.candidatesInText, ok });
  }
  return {
    accuracy: Number((correct / gold.length).toFixed(3)),
    confusion,
    definition: "direct=stance possible, listicle=neutral only, absent/credit_ocr=irrelevant",
    rows,
  };
}

// --relevance-only merges the free numbers into the existing report without
// repeating a single model call.
if (args["relevance-only"] === true && existsSync("data/analyses/stance-ablation.json")) {
  const existing = JSON.parse(readFileSync("data/analyses/stance-ablation.json", "utf8"));
  const gate = computeRelevanceRows();
  existing.relevanceGate = gate;
  writeFileSync("data/analyses/stance-ablation.json", JSON.stringify(existing, null, 2));
  console.log(`Relevance gate accuracy: ${gate.accuracy}`);
  console.log(JSON.stringify(gate.confusion, null, 2));
  process.exit(0);
}

type Pred = { label: string; basis: string; verified?: boolean };

function reduce(label: string): "favorable" | "critical" | "no_stance" {
  if (label === "favorable" || label === "critical") return label;
  if (label === "neutral" || label === "irrelevant" || label === "ambiguous" || label === "unclear") return "no_stance";
  return "no_stance";
}

function evaluate(name: string, predictions: Map<string, Pred>) {
  let correct = 0;
  let goldStance = 0;
  let hitStance = 0;
  let predictedStance = 0;
  let falseStance = 0;
  const rows: Array<Record<string, unknown>> = [];

  for (const item of gold) {
    const key = `${item.video_id}|${item.candidate_id}`;
    const prediction = predictions.get(key) ?? { label: "unclear", basis: "missing" };
    const goldClass = reduce(item.label);
    const predClass = reduce(prediction.label);
    const ok = goldClass === predClass;
    if (ok) correct++;
    if (item.label === "favorable" || item.label === "critical") {
      goldStance++;
      if (predClass === goldClass) hitStance++;
    }
    if (predClass === "favorable" || predClass === "critical") {
      predictedStance++;
      if (goldClass === "no_stance") falseStance++;
    }
    rows.push({
      n: item.n,
      candidate: item.candidate_id,
      gold: item.label,
      pred: prediction.label,
      basis: prediction.basis,
      ok,
    });
  }

  return {
    config: name,
    agreement: Number((correct / gold.length).toFixed(3)),
    stanceRecall: goldStance ? Number((hitStance / goldStance).toFixed(3)) : 0,
    stancePrecision: predictedStance ? Number((1 - falseStance / predictedStance).toFixed(3)) : 0,
    falseStance,
    predictedStance,
    goldStance,
    rows,
  };
}

const accessToken = await getAccessToken();
const results: Record<string, unknown> = {};
const predictionsByConfig: Record<string, Map<string, Pred>> = {};

// ── A. Baseline (cached artifact, no calls) ──────────────────────────────
if (only.includes("baseline")) {
  const predictions = new Map<string, Pred>();
  for (const item of gold) {
    const row = baselineByKey.get(`${item.video_id}|${item.candidate_id}`);
    predictions.set(`${item.video_id}|${item.candidate_id}`, {
      label: row?.label ?? "unclear",
      basis: row?.basis ?? "missing",
      verified: row?.gemini?.evidence_verified,
    });
  }
  predictionsByConfig.baseline = predictions;
}

// ── B. Few-shot flash + relevance hint ───────────────────────────────────
async function runModel(configName: string, model: string, fewShot: boolean, thinkingBudget: number) {
  const predictions = new Map<string, Pred>();
  let calls = 0;
  let failures = 0;
  await mapWithConcurrency([...byVideo.entries()], concurrency, async ([videoId, items]) => {
    const video = videos.get(videoId)!;
    const targets = items.map((item) => CANDIDATES_BY_ID[item.candidate_id]);
    const relevance = items
      .map((item) => `${item.candidate_id}: ${assessRelevance(video, CANDIDATES_BY_ID[item.candidate_id]).kind}`)
      .join(", ");
    try {
      const verdicts = await classifyStancesBatch({
        video,
        targets: targets.map((candidate) => ({ id: candidate.id, name: candidate.name })),
        config: { project, location, model, accessToken, thinkingBudget },
        fewShot,
        relevance,
      });
      calls++;
      for (const verdict of verdicts) {
        const evidence = matchEvidence(verdict.evidence_quote, video);
        predictions.set(`${videoId}|${verdict.candidate_id}`, {
          label: verdict.stance,
          basis: evidence.verified ? `model:${evidence.mode}` : "model:unverified",
          verified: evidence.verified,
        });
      }
    } catch (error) {
      failures++;
      console.warn(`  ! ${configName} ${videoId}: ${(error as Error).message.slice(0, 120)}`);
    }
  });
  return { predictions, calls, failures };
}

if (only.includes("fewshot")) {
  const run = await runModel("fewshot", "gemini-2.5-flash", true, 0);
  predictionsByConfig.fewshot = run.predictions;
  (results as any).fewshotMeta = { calls: run.calls, failures: run.failures, model: "gemini-2.5-flash", fewShot: true };
}

// ── C. Gemini 2.5 Pro zero-shot ──────────────────────────────────────────
if (only.includes("pro")) {
  const run = await runModel("pro", "gemini-2.5-pro", false, 512);
  predictionsByConfig.pro = run.predictions;
  (results as any).proMeta = { calls: run.calls, failures: run.failures, model: "gemini-2.5-pro", thinkingBudget: 512 };
}

// ── D. Embedding nearest-anchor ──────────────────────────────────────────
if (only.includes("embeddings")) {
  const predictions = new Map<string, Pred>();
  const anchors = Object.entries(STANCE_ANCHORS).flatMap(([family, phrases]) =>
    phrases.map((phrase) => ({ family, phrase })),
  );
  const anchorVectors = await embedTexts(
    { project, location, accessToken },
    anchors.map((anchor) => anchor.phrase),
  );
  let failures = 0;
  await mapWithConcurrency([...byVideo.entries()], 3, async ([videoId, items]) => {
    const video = videos.get(videoId)!;
    try {
      const [vector] = await embedTexts(
        { project, location, accessToken },
        [[video.caption ?? "", ...(video.on_screen_text ?? []), video.transcript ?? ""].filter(Boolean).join("\n").slice(0, 6000)],
      );
      const byFamily = (family: string, n = 2) =>
        anchors
          .map((anchor, index) => ({ family: anchor.family, value: cosine(vector, anchorVectors[index]) }))
          .filter((entry) => entry.family === family)
          .map((entry) => entry.value)
          .sort((a, b) => b - a)
          .slice(0, n)
          .reduce((sum, value, _, array) => sum + value / array.length, 0);
      const favorable = byFamily("favorable");
      const critical = byFamily("critical");
      const neutral = byFamily("neutral");
      const score = favorable - critical;
      let label = "neutral";
      if (neutral >= Math.max(favorable, critical) - 0.005) label = "neutral";
      else if (score > 0.01) label = "favorable";
      else if (score < -0.01) label = "critical";
      for (const item of items) {
        predictions.set(`${videoId}|${item.candidate_id}`, { label, basis: "embedding:anchors" });
      }
    } catch (error) {
      failures++;
      console.warn(`  ! embeddings ${videoId}: ${(error as Error).message.slice(0, 100)}`);
    }
  });
  predictionsByConfig.embeddings = predictions;
  (results as any).embeddingsMeta = { model: "gemini-embedding-001", failures };
}

// ── Relevance gate accuracy (separate signal, no calls) ──────────────────
const gate = computeRelevanceRows();
const relevanceRows = gate.rows;
const relevanceCorrect = relevanceRows.filter((row: any) => row.ok).length;

const evaluations = Object.entries(predictionsByConfig).map(([name, predictions]) => evaluate(name, predictions));

const payload = {
  generatedAt: new Date().toISOString(),
  goldSet: { size: gold.length, distribution: gold.reduce<Record<string, number>>((acc, item) => { acc[item.label] = (acc[item.label] ?? 0) + 1; return acc; }, {}) },
  relevanceGate: {
    accuracy: Number((relevanceCorrect / gold.length).toFixed(3)),
    rows: relevanceRows,
  },
  evaluations,
  meta: results,
};

writeFileSync("data/analyses/stance-ablation.json", JSON.stringify(payload, null, 2));

console.log(`Gold set: ${gold.length} videos — ${JSON.stringify(payload.goldSet.distribution)}\n`);
console.log(
  table(
    evaluations.map((evaluation) => ({
      config: evaluation.config,
      agreement: evaluation.agreement,
      stance_recall: evaluation.stanceRecall,
      stance_precision: evaluation.stancePrecision,
      false_stance: evaluation.falseStance,
      predicted_stance: evaluation.predictedStance,
    })),
  ),
);
console.log(`\nRelevance gate accuracy: ${payload.relevanceGate.accuracy}`);
console.log("\nDisagreements (few-shot):");
const few = evaluations.find((evaluation) => evaluation.config === "fewshot");
if (few) {
  for (const row of few.rows.filter((entry: any) => !entry.ok)) {
    console.log(`  #${row.n} ${row.candidate} gold=${row.gold} pred=${row.pred} (${row.basis})`);
  }
}
console.log("\nWrote data/analyses/stance-ablation.json");
