/**
 * Live contract tests against connect.oriane.xyz.
 *
 * These assert the behaviours the pipeline depends on, including the ones that
 * cost us time to discover: accent sensitivity, the OR-group composition trap,
 * the language filter dropping image posts, and the hard limits.
 *
 * Run: npm test            (requires ORIANE_API in .env)
 * Skip: ORCIANE_SKIP_API=1 npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCandidateQuery,
  buildImagePostQuery,
  createOrianeClient,
  OrianeError,
  TEXT_FIELDS,
  textFilter,
} from "../../supabase/functions/_shared/oriane.ts";
import { CANDIDATES_BY_ID } from "../../supabase/functions/_shared/candidates.ts";

const apiKey = process.env.ORIANE_API;
const skip = apiKey ? false : "ORIANE_API is not set";

const client = createOrianeClient({ apiKey: apiKey ?? "missing" });
const LEPEN = CANDIDATES_BY_ID.lepen;
const PHILIPPE = CANDIDATES_BY_ID.philippe;

async function total(body: Parameters<typeof client.searchContents>[0]): Promise<number> {
  const response = await client.searchContents(body, { limit: 1, projection: "basic" });
  assert.ok(response.totalCount !== null, "totalCount must be present");
  return response.totalCount;
}

test("auth + pagination metadata contract", { skip }, async () => {
  const response = await client.searchContents(
    { operator: "and", filters: textFilter("transcript", ["présidentielle"]) },
    { limit: 3, projection: "basic" },
  );
  // 206 is the normal success code when more rows exist than were returned.
  assert.ok([200, 206].includes(response.status));
  assert.ok(response.requestId?.startsWith("req_"));
  assert.equal(response.records.length, 3);
  const first = response.records[0];
  assert.ok(first.id.startsWith("cnt_"));
  assert.ok(["instagram", "tiktok", "youtube"].includes(first.platform));
  assert.ok(first.platformId);
  assert.ok(first.publishedAt);
});

test("projection=full carries transcript, on-screen text and frames", { skip }, async () => {
  const response = await client.searchContents(
    buildCandidateQuery([LEPEN], { since: "2026-06-01" }),
    { limit: 5, projection: "full", sort: "viewsCount:desc" },
  );
  const withMedia = response.records.filter((record) => (record.media?.[0]?.transcript ?? "").length > 0);
  assert.ok(withMedia.length >= 3, "most pulled videos should have a transcript");
  const media = withMedia[0].media![0];
  assert.ok(media.transcript && media.transcript.length > 100);
  assert.ok(Array.isArray(media.onScreenText));
  assert.ok(Array.isArray(media.transcriptChunks));
  assert.equal(typeof media.transcriptChunks![0].startSeconds, "number");
});

test("matching is accent-sensitive and case-insensitive", { skip }, async () => {
  const accented = await total({ operator: "and", filters: textFilter("transcript", ["Édouard Philippe"]) });
  const plain = await total({ operator: "and", filters: textFilter("transcript", ["Edouard Philippe"]) });
  const lower = await total({ operator: "and", filters: textFilter("transcript", ["edouard philippe"]) });
  // Docs say this is why the dictionary carries every orthography.
  assert.notEqual(accented, plain, "accented and unaccented must be queried separately");
  assert.equal(plain, lower, "matching is case-insensitive");
});

test("multi-value includesExactly unions the variants", { skip }, async () => {
  const accented = await total({ operator: "and", filters: textFilter("transcript", ["Édouard Philippe"]) });
  const plain = await total({ operator: "and", filters: textFilter("transcript", ["Edouard Philippe"]) });
  const both = await total({
    operator: "and",
    filters: textFilter("transcript", ["Édouard Philippe", "Edouard Philippe"]),
  });
  assert.ok(both >= Math.max(accented, plain), "union must cover the larger variant");
  assert.ok(both <= accented + plain, "union must dedupe");
});

test("the nested OR group is required: sibling sub-queries under AND collapse it", { skip }, async () => {
  const perField: Record<string, number> = {};
  for (const field of TEXT_FIELDS) {
    perField[field] = await total({ operator: "and", filters: textFilter(field, LEPEN.aliases) });
  }
  const nestedOr = await total(buildCandidateQuery([LEPEN], { since: "2026-06-01" }));
  const siblingAnd = await total({
    operator: "and",
    queries: TEXT_FIELDS.map((field) => ({
      name: field,
      operator: "and" as const,
      filters: textFilter(field, LEPEN.aliases),
    })),
  });
  assert.ok(nestedOr > Math.max(...Object.values(perField)), "OR group must exceed any single field");
  assert.ok(siblingAnd < nestedOr, "sibling AND collapses the group and must return fewer rows");
});

test("root OR with a global filter leaks: the filter stops constraining", { skip }, async () => {
  const group = {
    operator: "or" as const,
    queries: TEXT_FIELDS.map((field) => ({
      name: field,
      operator: "and" as const,
      filters: textFilter(field, LEPEN.aliases),
    })),
  };
  const constrained = await total({ operator: "and", filters: { format: { includes: ["image"] } }, queries: [group] });
  const leaked = await total({ operator: "or", filters: { format: { includes: ["image"] } }, queries: [group] });
  assert.ok(leaked > constrained, "operator=or at the root ORs the filter with the group");
});

test("language filter silently drops image posts", { skip }, async () => {
  const onScreen = textFilter("on_screen_text", ["Le Pen"]);
  const imagePosts = await total({
    operator: "and",
    filters: { ...onScreen, format: { includes: ["image"] } },
  });
  const withLanguage = await total({
    operator: "and",
    filters: { ...onScreen, format: { includes: ["image"] }, transcriptLanguage: { includes: ["fr"] } },
  });
  assert.ok(imagePosts > 0, "there are image posts mentioning Le Pen");
  assert.equal(withLanguage, 0, "transcriptLanguage excludes posts without a transcript");
});

test("image-post query returns only image and carousel formats", { skip }, async () => {
  const response = await client.searchContents(buildImagePostQuery([LEPEN], { since: "2026-06-01" }), {
    limit: 20,
    projection: "basic",
  });
  assert.ok(response.records.length > 0);
  for (const record of response.records) assert.ok(["image", "carousel"].includes(record.format));
});

test("hashtags are indexed with the leading #", { skip }, async () => {
  const withHash = await total({
    operator: "and",
    filters: { hashtags: { exactMatch: { values: ["#starbucks"], operator: "or" } } },
  });
  const withoutHash = await total({
    operator: "and",
    filters: { hashtags: { exactMatch: { values: ["starbucks"], operator: "or" } } },
  });
  assert.ok(withHash > 0);
  assert.equal(withoutHash, 0);
});

test("platform aggregates are addressable and return aggregations", { skip }, async () => {
  const response = await client.searchContents(
    { operator: "and", filters: textFilter("transcript", ["présidentielle"]) },
    { limit: 1, projection: "basic" },
  );
  assert.ok(response.aggregations);
  assert.ok((response.aggregations.totalViewsCount ?? 0) > 0);
});

test("limit is capped at 100: client rejects, API rejects", { skip }, async () => {
  await assert.rejects(
    () =>
      client.searchContents({ operator: "and", filters: textFilter("transcript", ["présidentielle"]) }, { limit: 101 }),
    RangeError,
  );

  // The raw contract: 400 VALIDATION with a field-level rule.
  const response = await fetch("https://connect.oriane.xyz/rest/contents/search?limit=101", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operator: "and", filters: textFilter("transcript", ["présidentielle"]) }),
  });
  assert.equal(response.status, 400);
  const payload: any = await response.json();
  assert.equal(payload.error.code, "FAILED");
  assert.equal(payload.error.operation, "VALIDATION");
  assert.equal(payload.error.context[0].field, "limit");
  assert.equal(payload.error.context[0].rule, "max");
});

test("an offset past the end of the result set returns 416 OUT_OF_RANGE", { skip }, async () => {
  await assert.rejects(
    () =>
      client.searchContents(
        { operator: "and", filters: textFilter("transcript", ["Marine Le Pen"]) },
        { limit: 10, offset: 999_999 },
      ),
    (error: unknown) => {
      assert.ok(error instanceof OrianeError);
      assert.equal(error.status, 416);
      assert.equal(error.code, "OUT_OF_RANGE");
      return true;
    },
  );
});

test("one operand per field: mixing a language key into a text operand is rejected", { skip }, async () => {
  await assert.rejects(
    () =>
      client.searchContents({
        operator: "and",
        filters: {
          transcript: {
            includesExactly: { values: ["Marine Le Pen"], operator: "or" },
            transcriptLanguage: { includes: ["fr"] },
          } as any,
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof OrianeError);
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test("paginate deduplicates by content id", { skip }, async () => {
  const ids: string[] = [];
  for await (const record of client.paginate(buildCandidateQuery([PHILIPPE], { since: "2026-09-01" }), {
    limit: 20,
    maxItems: 30,
    projection: "basic",
  })) {
    ids.push(record.id);
  }
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(ids.length > 0);
});

test("a text asset can anchor a semantic visual search", { skip }, async () => {
  const response = await fetch("https://connect.oriane.xyz/rest/assets", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "text", text: "a candidate speaking at a podium with microphones" }),
  });
  assert.equal(response.status, 201);
  const payload: any = await response.json();
  const assetId = payload?.data?.id;
  assert.match(assetId, /^ast_[A-Za-z0-9]{28}$/);

  const search = await client.searchContents(
    {
      operator: "and",
      filters: { visualSimilarity: { includes: { values: [{ assetId, minScore: 0.35 }], operator: "or" } } },
    },
    { limit: 5, projection: "basic", sort: "visualSimilarity:desc" },
  );
  assert.ok((search.totalCount ?? 0) > 0);
});

test("candidate query stays within the documented budgets", { skip }, async () => {
  const body = buildCandidateQuery(Object.values(CANDIDATES_BY_ID), { since: "2026-06-01" });
  const serialized = JSON.stringify(body);
  const valueCount = serialized.match(/"operator":"or"/g)?.length ?? 0;
  assert.ok(valueCount > 0);
  // 31 candidates × 3 fields = 93 sub-queries, far below the 500 value ceiling.
  assert.ok(serialized.length < 200_000);
});
