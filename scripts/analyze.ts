/**
 * Offline LLM batch over the pulled dataset.
 *
 *   npm run analyze -- --limit 40            # real calls (needs LLM_API_KEY)
 *   npm run analyze -- --dry-run             # write the prompts, call nothing
 *
 * Input : data/oriane/top10-all.json
 * Output: data/analyses/analyses.json, data/analyses/claims.json, data/analyses/prompts.json
 *
 * Strong mentions only by default: a surname-only match is not enough evidence
 * to ask a model for a leaning. Every returned quote is re-checked against the
 * source; unsupported labels are marked unverified and downgraded to "unclear".
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CANDIDATES_BY_ID } from "../supabase/functions/_shared/candidates.ts";
import {
  buildPrompt,
  callLlm,
  mapWithConcurrency,
  parseAnalysis,
  PROMPT_VERSION,
  verifyAnalysis,
} from "../supabase/functions/_shared/analyze.ts";
import type { AnalysisRow, ClaimRow, VideoRow } from "../supabase/functions/_shared/types.ts";
import { loadEnv, num, parseArgs, table } from "./lib.ts";

loadEnv();
const args = parseArgs(process.argv.slice(2));

const inputPath = String(args.input ?? "data/oriane/top10-all.json");
const outDir = "data/analyses";
const limit = num(args.limit, 0) || Infinity;
const concurrency = num(args.concurrency, 4);
const dryRun = args["dry-run"] === true || !process.env.LLM_API_KEY;
const model = String(args.model ?? process.env.LLM_MODEL ?? "gpt-4.1-mini");
const includeWeak = args["include-weak"] === true;

const dataset = JSON.parse(readFileSync(inputPath, "utf8")) as {
  videos: VideoRow[];
  mentions: Array<{ video_id: string; candidate_id: string; strength: string }>;
};

const videosById = new Map(dataset.videos.map((video) => [video.id, video]));

const pairs = dataset.mentions
  .filter((mention) => includeWeak || mention.strength === "strong")
  .filter((mention) => videosById.has(mention.video_id) && CANDIDATES_BY_ID[mention.candidate_id])
  .filter((mention, index, all) => {
    // one pair per (video, candidate)
    const key = `${mention.video_id}|${mention.candidate_id}`;
    return all.findIndex((other) => `${other.video_id}|${other.candidate_id}` === key) === index;
  })
  .slice(0, limit);

console.log(`${pairs.length} (video × candidate) pairs from ${dataset.videos.length} videos`);
if (dryRun) console.log("Dry run: writing prompts only (no LLM_API_KEY or --dry-run).");

mkdirSync(outDir, { recursive: true });

const prompts = pairs.map((pair) => {
  const video = videosById.get(pair.video_id)!;
  const candidate = CANDIDATES_BY_ID[pair.candidate_id];
  return { video_id: video.id, candidate_id: candidate.id, messages: buildPrompt(video, candidate) };
});
writeFileSync(
  `${outDir}/prompts.json`,
  JSON.stringify({ promptVersion: PROMPT_VERSION, model, prompts }, null, 2),
);

const analyses: AnalysisRow[] = [];
const claims: ClaimRow[] = [];
const failures: Array<{ video_id: string; candidate_id: string; error: string }> = [];

if (!dryRun) {
  const config = {
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.LLM_API_KEY!,
    model,
  };

  await mapWithConcurrency(prompts, concurrency, async (prompt, index) => {
    const video = videosById.get(prompt.video_id)!;
    const candidate = CANDIDATES_BY_ID[prompt.candidate_id];
    try {
      const raw = await callLlm(config, prompt.messages);
      const verified = verifyAnalysis(video, candidate, parseAnalysis(raw), model);
      analyses.push(verified.analysis);
      claims.push(...verified.claims);
    } catch (error) {
      failures.push({ video_id: prompt.video_id, candidate_id: prompt.candidate_id, error: (error as Error).message });
    }
    if ((index + 1) % 10 === 0) process.stdout.write(`  ${index + 1}/${prompts.length}\n`);
  });

  writeFileSync(`${outDir}/analyses.json`, JSON.stringify(analyses, null, 2));
  writeFileSync(`${outDir}/claims.json`, JSON.stringify(claims, null, 2));
  writeFileSync(`${outDir}/failures.json`, JSON.stringify(failures, null, 2));

  const verified = analyses.filter((analysis) => analysis.evidence_verified).length;
  const byLeaning: Record<string, number> = {};
  for (const analysis of analyses) {
    byLeaning[analysis.leaning] = (byLeaning[analysis.leaning] ?? 0) + 1;
  }
  console.log(
    "\n" +
      table([
        { metric: "pairs attempted", value: pairs.length },
        { metric: "analyses stored", value: analyses.length },
        { metric: "evidence verified", value: verified },
        { metric: "verification rate", value: `${((verified / Math.max(analyses.length, 1)) * 100).toFixed(1)}%` },
        { metric: "claims kept", value: claims.length },
        { metric: "failures", value: failures.length },
        ...Object.entries(byLeaning).map(([leaning, count]) => ({ metric: leaning, value: count })),
      ]),
  );
  console.log(`\nWrote ${outDir}/analyses.json and ${outDir}/claims.json`);
} else {
  console.log(`Wrote ${outDir}/prompts.json (${prompts.length} prompts) — run without --dry-run to call the model.`);
}
