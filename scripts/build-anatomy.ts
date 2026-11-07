/**
 * Pre-compute the "Anatomy of an opinion" payload for the entry page.
 *
 *   npm run anatomy
 *
 * Writes data/analyses/anatomy.json:
 *   - entry: the ranked entry-page cards (one per creator, quality-gated)
 *   - items: every video's anatomy, so the API can serve any video id offline
 *
 * Each item carries `sourceText` so a test can prove every segment is a
 * verbatim slice. The API response omits it to keep payloads small.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { buildAnatomy, selectEntry, sourceTextOf, LEGEND } from "../api/src/anatomy.ts";
import { buildIndex } from "../api/src/derive.ts";
import { loadFromArtifacts, repoPath } from "../api/src/sources.ts";

const dataset = loadFromArtifacts();
const index = buildIndex(dataset);

const entry = selectEntry(index, 6);
const entryIds = new Set(entry.map((item) => item.videoId));

const items = dataset.videos
  .map((video) => {
    const anatomy = buildAnatomy(index, video.id, dataset.facts);
    if (!anatomy || anatomy.segments.length === 0) return null;
    const { text: cleaned } = sourceTextOf(video);
    return {
      ...anatomy,
      entry: entryIds.has(video.id),
      sourceText: cleaned,
    };
  })
  .filter(Boolean)
  .sort((a: any, b: any) => b.quality - a.quality);

const payload = {
  generatedAt: new Date().toISOString(),
  method: {
    source: "data/oriane + api/data/facts.json + runs/v2-fuzzy stance",
    segments: "opening → fact (anchor sentence) → meaning (next sentence) → verdict (verified quote)",
    qualityGate: "entry requires coverage=full and quality>=0.6",
    modelCalls: 0,
  },
  legend: LEGEND,
  entry: entry.map((item) => {
    const item_ = items.find((row: any) => row.videoId === item.videoId)!;
    return { videoId: item.videoId, quality: item_.quality, coverage: item_.coverage };
  }),
  items,
};

mkdirSync(repoPath("data/analyses"), { recursive: true });
writeFileSync(repoPath("data/analyses/anatomy.json"), JSON.stringify(payload, null, 2));

const byCoverage = items.reduce((acc: Record<string, number>, item: any) => {
  acc[item.coverage] = (acc[item.coverage] ?? 0) + 1;
  return acc;
}, {});

console.log(`Anatomy: ${items.length} items, entry ${entry.length} (quality>=0.6)`);
console.log(`Coverage: ${JSON.stringify(byCoverage)}`);
for (const item of entry) {
  const row: any = items.find((candidate: any) => candidate.videoId === item.videoId);
  console.log(
    `  ${row.attribution.handle.padEnd(22)} ${row.coverage.padEnd(10)} q=${row.quality} ` +
    `${String(row.attribution.views ?? 0).padStart(8)} views  fact=${row.fact?.id ?? "-"} verdict=${row.verdict?.leaning ?? "-"}`,
  );
}
console.log("Wrote data/analyses/anatomy.json");
