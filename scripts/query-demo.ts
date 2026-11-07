/**
 * Live query demo: prints the exact Oriane request bodies used by the pipeline
 * and the real counts they return today.
 *
 *   npm run demo
 *
 * This is the executable version of docs/oriane-query-playbook.md. Use it to
 * sanity-check the candidate dictionary before the 10:00 ingestion.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { CANDIDATES, CANDIDATES_BY_ID, DEMO_CANDIDATE_IDS, TOPICS } from "../supabase/functions/_shared/candidates.ts";
import { QUERY_CATALOG } from "../supabase/functions/_shared/queries.ts";
import {
  buildCandidateQuery,
  buildImagePostQuery,
  buildTopicQuery,
  createOrianeClient,
  TEXT_FIELDS,
} from "../supabase/functions/_shared/oriane.ts";
import { loadEnv, requireEnv, table } from "./lib.ts";

loadEnv();
const client = createOrianeClient({ apiKey: requireEnv("ORIANE_API") });

const SINCE = process.env.ORIANE_SINCE ?? "2026-06-01";
const PLATFORMS = ["instagram", "tiktok", "youtube"] as const;

async function total(body: Parameters<typeof client.searchContents>[0], projection: "basic" | "default" | "full" = "basic") {
  const response = await client.searchContents(body, { limit: 1, projection });
  return response;
}

console.log(`Oriane contents/search — live counts since ${SINCE}\n`);

const rows: Array<Record<string, unknown>> = [];

// 1. Topic discovery: the election lexicon, no candidate names.
const topicBody = buildTopicQuery(TOPICS.presidentielle_2027.terms, {
  since: SINCE,
  platforms: [...PLATFORMS],
});
const topic = await total(topicBody);
rows.push({ query: "topic: presidentielle", total: topic.totalCount, ms: topic.executionTime });

// 2. Per-candidate balanced pull, the shape the ingestion actually uses.
for (const candidate of CANDIDATES) {
  const body = buildCandidateQuery([candidate], { since: SINCE, platforms: [...PLATFORMS] });
  const response = await total(body);
  rows.push({
    query: `candidate: ${candidate.id}`,
    total: response.totalCount,
    ms: response.executionTime,
  });
}

// 3. Image and carousel posts only.
const imageBody = buildImagePostQuery(CANDIDATES.slice(0, 4), {
  since: SINCE,
  platforms: [...PLATFORMS],
});
const image = await total(imageBody);
rows.push({ query: "image posts: 4 candidates", total: image.totalCount, ms: image.executionTime });

console.log(table(rows));

// Accent sensitivity: the single most important ingestion gotcha.
console.log("\nAccent variants in the transcript index (includesExactly):");
const accentRows: Array<Record<string, unknown>> = [];
for (const value of ["Édouard Philippe", "Edouard Philippe", "Mélenchon", "Melenchon", "Melanchon"]) {
  const response = await total({
    operator: "and",
    filters: { transcript: { includesExactly: { values: [value], operator: "or" } } },
  });
  accentRows.push({ value, total: response.totalCount });
}
console.log(table(accentRows));

// The canonical body, verbatim, for the documentation.
const example = buildCandidateQuery([CANDIDATES_BY_ID.lepen], {
  since: SINCE,
  platforms: [...PLATFORMS],
});

console.log("\nCanonical body for one candidate (POST /rest/contents/search):");
console.log(JSON.stringify(example, null, 2));

console.log("\nField coverage in the first 20 videos for 'lepen' (projection=full):");
const page = await client.searchContents(example, {
  limit: 20,
  projection: "full",
  sort: "viewsCount:desc",
});
const coverage = {
  total: page.totalCount,
  withTranscript: page.records.filter((r) => (r.media?.[0]?.transcript ?? "").length > 0).length,
  withOnScreenText: page.records.filter((r) => (r.media?.[0]?.onScreenText ?? []).length > 0).length,
  withCaption: page.records.filter((r) => (r.caption ?? "").length > 0).length,
  imagePosts: page.records.filter((r) => r.format !== "video").length,
  platforms: page.records.reduce<Record<string, number>>((acc, r) => {
    acc[r.platform] = (acc[r.platform] ?? 0) + 1;
    return acc;
  }, {}),
};
console.log(JSON.stringify(coverage, null, 2));

mkdirSync("data", { recursive: true });
writeFileSync(
  "data/query-plan.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      since: SINCE,
      textFields: TEXT_FIELDS,
      counts: rows,
      accentProbe: accentRows,
      canonicalBody: example,
    },
    null,
    2,
  ),
);

// Export every catalog query with its resolved body, so the whole query set is
// inspectable (and diffable) without reading TypeScript.
const catalog = QUERY_CATALOG.map((spec) => ({
  id: spec.id,
  facet: spec.facet,
  title: spec.title,
  question: spec.question,
  notes: spec.notes ?? null,
  params: spec.params ?? null,
  body: spec.build({ candidateIds: DEMO_CANDIDATE_IDS, since: SINCE }),
}));
mkdirSync("data/oriane", { recursive: true });
writeFileSync(
  "data/oriane/_query-catalog.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), count: catalog.length, queries: catalog }, null, 2),
);

console.log(`\nWrote data/query-plan.json and data/oriane/_query-catalog.json (${catalog.length} queries)`);
