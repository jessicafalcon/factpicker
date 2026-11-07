/**
 * Measures which filters actually constrain results, and how much data each one
 * has. Writes data/oriane/_filter-matrix.json, which docs/oriane-query-playbook.md
 * quotes.
 *
 *   npm run probe:filters
 *
 * The point is granularity: a filter that returns the whole corpus is not a
 * filter, and a filter that returns zero on a candidate slice is a trap.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { CANDIDATES_BY_ID } from "../supabase/functions/_shared/candidates.ts";
import { createOrianeClient, TEXT_FIELDS, textFilter } from "../supabase/functions/_shared/oriane.ts";
import type { ContentFilters, ContentQuery } from "../supabase/functions/_shared/oriane.ts";
import { candidateOrGroup, combine } from "../supabase/functions/_shared/queries.ts";
import { loadEnv, requireEnv, table } from "./lib.ts";

loadEnv();
const client = createOrianeClient({ apiKey: requireEnv("ORIANE_API") });
const LEPEN = CANDIDATES_BY_ID.lepen;
const SINCE = "2026-06-01";
const ctx = { candidates: [LEPEN], since: SINCE };

const baselineBody = combine(ctx, candidateOrGroup([LEPEN]));
const baseline = await client.searchContents(baselineBody, { limit: 1, projection: "basic" });
const baselineTotal = baseline.totalCount ?? 0;

interface Probe {
  id: string;
  facet: string;
  filter: ContentFilters | null;
  supported: boolean;
  total: number | null;
  coverage: number | null;
  note: string;
}

const probes: Probe[] = [];

async function probe(
  id: string,
  facet: string,
  filter: ContentFilters | null,
  note: string,
  supported = true,
): Promise<void> {
  const body: ContentQuery = filter
    ? combine(ctx, candidateOrGroup([LEPEN]), filter)
    : combine(ctx, candidateOrGroup([LEPEN]));
  try {
    const response = await client.searchContents(body, { limit: 1, projection: "basic" });
    const total = response.totalCount ?? 0;
    probes.push({
      id,
      facet,
      filter,
      supported,
      total,
      coverage: baselineTotal ? Number((total / baselineTotal).toFixed(4)) : null,
      note,
    });
  } catch (error) {
    probes.push({ id, facet, filter, supported: false, total: null, coverage: null, note: (error as Error).message.slice(0, 120) });
  }
}

// Baseline for the whole candidate slice.
probes.push({
  id: "baseline_lepen",
  facet: "baseline",
  filter: null,
  supported: true,
  total: baselineTotal,
  coverage: 1,
  note: "All formats, all platforms, French + foreign, since 2026-06-01.",
});

await probe("platform_tiktok", "platform", { platform: { includes: ["tiktok"] } }, "Single platform slice.");
await probe("platform_instagram", "platform", { platform: { includes: ["instagram"] } }, "Single platform slice.");
await probe("platform_youtube", "platform", { platform: { includes: ["youtube"] } }, "Single platform slice.");

await probe("format_image", "format", { format: { includes: ["image"] } }, "Still images.");
await probe("format_carousel", "format", { format: { includes: ["carousel"] } }, "Carousel albums.");
await probe("format_video", "format", { format: { includes: ["video"] } }, "Video.");
await probe("platform_type_reel", "platformType", {
  platformType: { includes: [{ platform: "instagram", type: "reel" }] },
}, "Native types are addressable per platform.");
await probe("platform_type_short", "platformType", {
  platformType: { includes: [{ platform: "youtube", type: "short" }] },
}, "YouTube Shorts.");

await probe("followers_1m_plus", "profileFollowersCount", { profileFollowersCount: { min: 1_000_000 } }, "Mega accounts.");
await probe("followers_10k_100k", "profileFollowersCount", { profileFollowersCount: { min: 10_000, max: 100_000 } }, "Micro creators.");
await probe("followers_under_10k", "profileFollowersCount", { profileFollowersCount: { max: 10_000 } }, "Nano creators.");

await probe("engagement_10_plus", "engagementRatePerViews", {
  engagementRatePerViews: { min: 10 },
  viewsCount: { min: 10_000 },
}, "High engagement, with a view floor to remove ratio noise.");
await probe("views_1m_plus", "viewsCount", { viewsCount: { min: 1_000_000 } }, "Viral threshold.");
await probe("views_under_10k", "viewsCount", { viewsCount: { max: 10_000 } }, "Long tail.");

await probe("hashtag_with_hash", "hashtags", {
  hashtags: { exactMatch: { values: ["#starbucks"], operator: "or" } },
}, "Non-campaign tag inside the candidate slice: expect 0. Values are stored WITH '#'.");
await probe("hashtag_without_hash", "hashtags", {
  hashtags: { exactMatch: { values: ["starbucks"], operator: "or" } },
}, "Same tag without '#': returns zero.");
await probe("hashtag_presidentielle", "hashtags", {
  hashtags: { includesExactly: { values: ["#presidentielle2027", "#presidentielle"], operator: "or" } },
}, "Campaign hashtags exist but are sparse relative to the text mentions.");

await probe("profile_handle_cnews", "profileHandle", {
  profileHandle: { includesExactly: { values: ["cnews"], operator: "or" } },
}, "Newsroom account slice.");
await probe("audio_marseillaise", "audioTitle", {
  audioTitle: { includesExactly: { values: ["La Marseillaise"], operator: "or" } },
}, "Exact audio title.");
await probe("location_paris", "locationCompleteAddress", {
  locationCompleteAddress: { includesExactly: { values: ["Paris"], operator: "or" } },
}, "Tagged location: sparse, but non-zero.");
await probe("mentions_any", "hasMentions", { hasMentions: true }, "Tagged accounts.");
await probe("coauthors_any", "hasCoAuthors", { hasCoAuthors: true }, "Duets, stitches, collabs.");

await probe("language_fr_transcript", "transcriptLanguage", {
  transcriptLanguage: { includes: ["fr"] },
}, "WARNING: drops image posts, which have no transcript.");
await probe("language_fr_caption", "captionLanguage", {
  captionLanguage: { includes: ["fr"] },
}, "Safer language filter for image posts.");

await probe("unsupported_duration", "durationSeconds", { durationSeconds: { min: 30 } } as any, "No duration filter exists.", false);

// Vision: create a text anchor once, then measure thresholds.
let assetId: string | null = null;
try {
  const response = await fetch("https://connect.oriane.xyz/rest/assets", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.ORIANE_API}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "text", text: "a politician speaking at a podium with microphones and a flag" }),
  });
  const payload: any = await response.json();
  assetId = payload?.data?.id ?? null;
} catch {
  assetId = null;
}

for (const minScore of [0.2, 0.3, 0.45, 0.6]) {
  if (!assetId) {
    probes.push({ id: `vision_${minScore}`, facet: "visualSimilarity", filter: null, supported: false, total: null, coverage: null, note: "asset creation failed" });
    continue;
  }
  await probe(
    `vision_${minScore}`,
    "visualSimilarity",
    { visualSimilarity: { includes: { values: [{ assetId, minScore }], operator: "or" } } },
    `Semantic visual similarity at minScore ${minScore}. Higher = tighter scene match.`,
  );
}

mkdirSync("data/oriane", { recursive: true });
writeFileSync(
  "data/oriane/_filter-matrix.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      candidate: LEPEN.id,
      since: SINCE,
      baselineTotal,
      visionAssetId: assetId,
      probes,
    },
    null,
    2,
  ),
);

console.log(
  table(
    probes.map((probe) => ({
      probe: probe.id,
      facet: probe.facet,
      total: probe.total ?? "ERROR",
      coverage: probe.coverage ?? "-",
      supported: probe.supported,
    })),
  ),
);
console.log("\nWrote data/oriane/_filter-matrix.json");
