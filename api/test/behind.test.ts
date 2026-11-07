import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, execute } from "../src/app.ts";
import { createEmbeddingClient, loadFromArtifacts } from "../src/sources.ts";
import { buildIndex, buildBehindTheNumbers } from "../src/derive.ts";

const dataset = loadFromArtifacts();
const index = buildIndex(dataset);
const ctx = createContext(dataset, createEmbeddingClient({}));
const run = (source: string) => execute({ source, context: ctx });

test("behind: strip is bounded, unique per creator and per fact, sorted by reach", () => {
  const items = buildBehindTheNumbers(index, { limit: 6 });
  assert.ok(items.length >= 4 && items.length <= 6, `unexpected length ${items.length}`);
  assert.equal(new Set(items.map((item) => item.video.creator_handle)).size, items.length, "duplicate creator");
  assert.equal(new Set(items.map((item) => item.fact.id)).size, items.length, "duplicate fact");
  const views = items.map((item) => item.video.views ?? 0);
  assert.deepEqual(views, [...views].sort((a, b) => b - a), "not sorted by views");
});

test("behind: only verified, non-unclear verdicts appear", () => {
  for (const item of buildBehindTheNumbers(index, { limit: 50 })) {
    assert.ok(["FAVORABLE", "CRITICAL", "NEUTRAL"].includes(item.leaning));
    const row = index.stanceByVideo.get(item.video.id)?.find((candidate) => candidate.quote);
    assert.ok(row, `${item.video.id}: no stance row`);
    assert.ok(item.video.url.startsWith("https://"), `${item.video.id}: missing url`);
    assert.ok(item.fact.category.length > 0);
  }
});

test("behind: verdicts are balanced rather than sorted into one camp", () => {
  const items = buildBehindTheNumbers(index, { limit: 6 });
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.leaning, (counts.get(item.leaning) ?? 0) + 1);
  assert.equal(counts.size, 3, `expected three leanings, got ${[...counts.keys()].join(",")}`);
  for (const [leaning, count] of counts) assert.ok(count <= 2, `${leaning}: ${count} of 6`);
});

test("behind: factId narrows the strip to that fact", () => {
  const items = buildBehindTheNumbers(index, { limit: 6, factId: "education_budget_2027" });
  assert.ok(items.length >= 3, "education strip too small");
  for (const item of items) assert.equal(item.fact.id, "education_budget_2027");
});

test("behind: a single slot is the highest-reach video, not a quota pick", () => {
  const [one] = buildBehindTheNumbers(index, { limit: 1 });
  const [top] = buildBehindTheNumbers(index, { limit: 6 });
  assert.ok((one.video.views ?? 0) >= (top.video.views ?? 0), "limit 1 should not be lower than the strip's top item");
});

test("behind: deterministic", () => {
  assert.deepEqual(buildBehindTheNumbers(index, { limit: 6 }), buildBehindTheNumbers(index, { limit: 6 }));
});

test("graphql: behindTheNumbers returns the client shape", async () => {
  const result = await run(`{
    behindTheNumbers(limit: 6) {
      leaning
      candidate { id name }
      fact { id category statement }
      video { id url thumbnailUrl views platform creator { handle } }
    }
  }`);
  assert.deepEqual(result.errors, undefined);
  const items = result.data.behindTheNumbers;
  assert.equal(items.length, 6);
  for (const item of items) {
    assert.ok(item.video.url.startsWith("https://"));
    assert.ok(item.video.creator.handle);
    assert.ok(["FAVORABLE", "CRITICAL", "NEUTRAL"].includes(item.leaning));
    assert.ok(item.fact.statement.length > 10);
    assert.ok(item.candidate?.name?.length, `${item.video.id}: missing candidate`);
  }
});
