/**
 * Ingest Oriane contents into the app database.
 *
 *   npm run ingest -- --per-candidate 30 --since 2026-06-01
 *   npm run ingest -- --dry-run --per-candidate 5     # snapshot only, no DB
 *
 * Always writes a JSON snapshot to data/snapshots/ so the demo can fall back to
 * a file if Supabase is unavailable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { CANDIDATES, CANDIDATES_BY_ID } from "../supabase/functions/_shared/candidates.ts";
import { createOrianeClient } from "../supabase/functions/_shared/oriane.ts";
import { ingestWithMentions, summarizeMentions } from "../supabase/functions/_shared/pipeline.ts";
import { createSupabaseStore } from "../supabase/functions/_shared/store.ts";
import type { CandidateDef, Platform } from "../supabase/functions/_shared/types.ts";
import { loadEnv, num, parseArgs, requireEnv, table } from "./lib.ts";

loadEnv();
const args = parseArgs(process.argv.slice(2));

const perCandidate = num(args["per-candidate"], 30);
const since = String(args.since ?? "2026-06-01");
const until = args.until ? String(args.until) : undefined;
const sort = String(args.sort ?? "viewsCount:desc");
const dryRun = args["dry-run"] === true;
// Surname-only aliases widen discovery ("Mélenchon" without "Jean-Luc"), and the
// local matcher records them as weak mentions. `--strong-only` keeps full names.
const includeWeak = args["strong-only"] !== true;
const outPath = String(args.out ?? `data/snapshots/oriane-${Date.now()}.json`);

const selectedIds = args.candidates
  ? String(args.candidates).split(",").map((s) => s.trim()).filter(Boolean)
  : CANDIDATES.map((c) => c.id);

const candidates: CandidateDef[] = selectedIds.map((id) => {
  const candidate = CANDIDATES_BY_ID[id];
  if (!candidate) throw new Error(`Unknown candidate id "${id}". Known: ${Object.keys(CANDIDATES_BY_ID).join(", ")}`);
  return candidate;
});

const platforms = (args.platforms ? String(args.platforms).split(",") : ["instagram", "tiktok", "youtube"]) as Platform[];

console.log(`Ingesting ${candidates.length} candidates × ${perCandidate} videos since ${since} (sort ${sort})`);
const startedAt = Date.now();

const client = createOrianeClient({ apiKey: requireEnv("ORIANE_API") });
const result = await ingestWithMentions(client, candidates, {
  perCandidate,
  since,
  until,
  sort,
  platforms,
  projection: "full",
  includeWeakAliases: includeWeak,
  onProgress: ({ candidate, total, elapsedMs }) => {
    process.stdout.write(`  ${candidate.padEnd(12)} ${String(total).padStart(4)} videos  (${elapsedMs} ms)\n`);
  },
});

const perCandidateRows = Object.entries(result.stats.perCandidate).map(([candidate, count]) => ({
  candidate,
  videos: count,
  mentions: result.mentions.filter((m) => m.candidate_id === candidate).length,
  strong: result.mentions.filter((m) => m.candidate_id === candidate && m.strength === "strong").length,
  weak: result.mentions.filter((m) => m.candidate_id === candidate && m.strength === "weak").length,
}));

console.log("\nPer-candidate pull:");
console.log(table(perCandidateRows));

const mentionSummary = summarizeMentions(result.mentions);
console.log("\nTotals:");
console.log(
  table([
    { metric: "requests", value: result.stats.requests },
    { metric: "records fetched", value: result.stats.fetched },
    { metric: "unique videos", value: result.stats.unique },
    { metric: "duplicate hits", value: result.stats.duplicateHits },
    { metric: "french", value: result.stats.french },
    { metric: "with transcript", value: result.stats.withTranscript },
    { metric: "image posts", value: result.stats.imagePosts },
    { metric: "mention rows", value: result.mentions.length },
    { metric: "videos × candidates", value: new Set(result.mentions.map((m) => `${m.video_id}|${m.candidate_id}`)).size },
    { metric: "elapsed ms", value: Date.now() - startedAt },
  ]),
);
console.log("\nMention strength:", JSON.stringify(mentionSummary));

const frenchOnly = args["french-only"] === true;
const videos = frenchOnly ? result.videos.filter((v) => v.is_french) : result.videos;
const videoIds = new Set(videos.map((v) => v.id));
const mentions = result.mentions.filter((m) => videoIds.has(m.video_id));

mkdirSync(outPath.slice(0, outPath.lastIndexOf("/")) || "data", { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      query: { since, until, sort, platforms, perCandidate, includeWeak },
      stats: result.stats,
      videos,
      mentions,
    },
    null,
    2,
  ),
);
console.log(`\nSnapshot: ${outPath} (${videos.length} videos, ${mentions.length} mentions)`);

if (dryRun || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log(
    dryRun
      ? "Dry run — skipping Supabase write."
      : "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase write.",
  );
} else {
  const store = createSupabaseStore({
    url: requireEnv("SUPABASE_URL"),
    serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  });
  const candidateRows = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    party: c.party,
    status: c.status,
    status_note: c.statusNote ?? null,
    aliases: c.aliases,
    weak_aliases: c.weakAliases,
    party_signals: c.partySignals,
    status_checked_at: new Date().toISOString(),
  }));
  const candidateCount = await store.upsert("candidates", candidateRows, "id");
  const videoCount = await store.upsert("videos", videos, "id");
  const mentionCount = await store.upsert("mentions", mentions, "video_id,candidate_id,source_key");
  console.log(`Supabase: ${candidateCount} candidates, ${videoCount} videos, ${mentionCount} mentions upserted.`);
}
