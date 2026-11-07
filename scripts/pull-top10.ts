/**
 * Pull the top N videos for every declared candidate and persist them.
 *
 *   npm run pull:top10
 *   npm run pull:top10 -- --per-candidate 10 --since 2026-06-01 --sort interactionsCount:desc
 *
 * Output:
 *   data/oriane/top10-all.json          combined, normalized (videos + mentions)
 *   data/oriane/<candidate>.json        one file per candidate
 *   data/oriane/_query.json             the exact Oriane body for each candidate
 *
 * Ranking by `interactionsCount` (likes+comments+shares) instead of views keeps
 * 400k-view niche posts from losing to 5M-view background noise.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { CANDIDATES } from "../supabase/functions/_shared/candidates.ts";
import { createOrianeClient } from "../supabase/functions/_shared/oriane.ts";
import { buildMentions, summarizeMentions, toVideoRow } from "../supabase/functions/_shared/pipeline.ts";
import { topVideosQuery } from "../supabase/functions/_shared/queries.ts";
import type { MentionRow, VideoRow } from "../supabase/functions/_shared/types.ts";
import { loadEnv, num, parseArgs, requireEnv, table } from "./lib.ts";

loadEnv();
const args = parseArgs(process.argv.slice(2));

const perCandidate = num(args["per-candidate"], 10);
const since = String(args.since ?? "2026-06-01");
const sort = String(args.sort ?? "interactionsCount:desc,viewsCount:desc");
const tiers = args.tiers ? String(args.tiers).split(",") : ["frontrunner", "major", "minor"];
const only = args.candidates ? String(args.candidates).split(",") : null;

const candidates = CANDIDATES.filter(
  (candidate) => tiers.includes(candidate.tier) && (!only || only.includes(candidate.id)),
);

const client = createOrianeClient({ apiKey: requireEnv("ORIANE_API") });
mkdirSync("data/oriane", { recursive: true });

const summaryRows: Array<Record<string, unknown>> = [];
const allVideos: VideoRow[] = [];
const allMentions: MentionRow[] = [];
const queries: Record<string, unknown> = {};
const seen = new Set<string>();

for (const candidate of candidates) {
  const body = topVideosQuery(candidate, { since });
  queries[candidate.id] = body;

  // Over-fetch, then keep French content first. Oriane's language filter cannot
  // be used here: `transcriptLanguage` drops image posts, which have no
  // transcript at all. So we rank, detect French locally, and backfill.
  const fetchSize = Math.min(Math.max(perCandidate * 4, perCandidate), 100);
  let response = await client.searchContents(body, {
    limit: fetchSize,
    projection: "full",
    sort,
  });
  let records = response.records;

  if (records.length < perCandidate && (response.totalCount ?? 0) > records.length) {
    const extra = await client.searchContents(body, {
      limit: Math.min((response.totalCount ?? 0) - records.length, 100),
      offset: records.length,
      projection: "full",
      sort,
    });
    records = [...records, ...extra.records];
  }

  const french = records.filter((record) => toVideoRow(record).is_french);
  const ordered = [
    ...french,
    ...records.filter((record) => !toVideoRow(record).is_french),
  ].slice(0, perCandidate);

  const videos: VideoRow[] = [];
  const mentions: MentionRow[] = [];
  for (const record of ordered) {
    const video = toVideoRow(record);
    videos.push(video);
    mentions.push(...buildMentions(record, CANDIDATES));
    if (!seen.has(video.id)) {
      seen.add(video.id);
      allVideos.push(video);
      allMentions.push(...buildMentions(record, CANDIDATES));
    }
  }

  writeFileSync(
    `data/oriane/${candidate.id}.json`,
    JSON.stringify(
      {
        candidate: {
          id: candidate.id,
          name: candidate.name,
          party: candidate.party,
          partyShort: candidate.partyShort,
          status: candidate.status,
          tier: candidate.tier,
          communities: candidate.communities,
          slogan: candidate.slogan ?? null,
        },
        query: { since, sort, perCandidate },
        totalAvailable: response.totalCount,
        videos,
        mentions,
      },
      null,
      2,
    ),
  );

  summaryRows.push({
    candidate: candidate.id,
    name: candidate.name,
    party: candidate.partyShort ?? "",
    tier: candidate.tier,
    available: response.totalCount ?? 0,
    pulled: videos.length,
    french: videos.filter((v) => v.is_french).length,
    imagePosts: videos.filter((v) => v.format === "image_post").length,
    views: videos.reduce((sum, v) => sum + (v.views ?? 0), 0),
  });
}

summaryRows.sort((a, b) => Number(b.available) - Number(a.available));
console.log(table(summaryRows));

const mentionCounts = summarizeMentions(allMentions);
writeFileSync(
  "data/oriane/top10-all.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      query: { since, sort, perCandidate, tiers },
      candidates: candidates.map((c) => ({
        id: c.id,
        name: c.name,
        party: c.party,
        partyShort: c.partyShort,
        status: c.status,
        tier: c.tier,
        slogan: c.slogan ?? null,
        communities: c.communities,
      })),
      stats: {
        candidates: candidates.length,
        videos: allVideos.length,
        mentions: allMentions.length,
        french: allVideos.filter((v) => v.is_french).length,
        imagePosts: allVideos.filter((v) => v.format === "image_post").length,
        withTranscript: allVideos.filter((v) => (v.transcript ?? "").length > 0).length,
        downloads: {
          instagram: allVideos.filter((v) => v.platform === "instagram").length,
          tiktok: allVideos.filter((v) => v.platform === "tiktok").length,
          youtube: allVideos.filter((v) => v.platform === "youtube").length,
        },
      },
      mentionCounts,
      videos: allVideos,
      mentions: allMentions,
    },
    null,
    2,
  ),
);
writeFileSync("data/oriane/_query.json", JSON.stringify(queries, null, 2));

console.log(
  `\n${allVideos.length} unique videos, ${allMentions.length} mentions across ${candidates.length} candidates.`,
);
console.log("Wrote data/oriane/top10-all.json, data/oriane/_query.json and per-candidate files.");
