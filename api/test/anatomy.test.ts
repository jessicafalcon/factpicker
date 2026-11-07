import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createContext, execute } from "../src/app.ts";
import { createEmbeddingClient, loadFromArtifacts, repoPath } from "../src/sources.ts";
import { buildIndex } from "../src/derive.ts";
import { buildAnatomy, selectEntry, cleanText, LEGEND } from "../src/anatomy.ts";

const dataset = loadFromArtifacts();
const ctx = createContext(dataset, createEmbeddingClient({}));
const index = buildIndex(dataset);
const run = (source: string, variableValues?: Record<string, unknown>) => execute({ source, variableValues, context: ctx });

const ARTIFACT = repoPath("data/analyses/anatomy.json");
const skip = existsSync(ARTIFACT) ? false : "run `npm run anatomy` first";
const artifact = skip ? null : JSON.parse(readFileSync(ARTIFACT, "utf8"));

test("entryPage returns ranked, quality-gated, one-per-creator cards", async () => {
  const result = await run(`{
    entryPage(limit: 6) {
      videoId quality coverage
      attribution { handle platform views url }
      fact { id statement }
      verdict { candidateId leaning verified }
      segments { role text }
    }
  }`);
  assert.deepEqual(result.errors, undefined);
  const items = result.data.entryPage;
  assert.equal(items.length, 6);
  assert.ok(items.every((item: any) => item.coverage === "full"));
  assert.ok(items.every((item: any) => item.quality >= 0.6));
  const handles = items.map((item: any) => item.attribution.handle);
  assert.equal(new Set(handles).size, handles.length, "one card per creator");
  // The brief opens on the 17 October thread: it must be represented.
  const protest = dataset.events.events.find((event) => event.id === "protest_17_october")!;
  assert.ok(items.some((item: any) => protest.video_ids.includes(item.videoId)), "no 17 October card");
  // Every card must name a fact and a candidate.
  assert.ok(items.every((item: any) => item.fact && item.verdict?.candidateId));
});

test("segments are verbatim slices with consistent offsets", async () => {
  const result = await run(`{ entryPage(limit: 6) { videoId composed segments { role text start end composedStart composedEnd } } }`);
  assert.deepEqual(result.errors, undefined);
  for (const item of result.data.entryPage) {
    assert.equal(item.composed, item.segments.map((segment: any) => segment.text).join(" "));
    const order = ["OPENING", "FACT", "MEANING", "VERDICT"];
    const seenRoles = item.segments.map((segment: any) => segment.role);
    // The composed quote follows the design's steps, not the spoken order.
    assert.deepEqual(seenRoles, order.filter((role) => seenRoles.includes(role)));
    for (const segment of item.segments) {
      assert.equal(
        item.composed.slice(segment.composedStart, segment.composedEnd),
        segment.text,
        `${item.videoId}/${segment.role} composed offsets drifted`,
      );
      assert.ok(segment.end > segment.start, `${item.videoId}/${segment.role} empty span`);
    }
    // Source spans must be pairwise disjoint even when re-ordered.
    const spans = item.segments.map((segment: any) => [segment.start, segment.end]);
    for (let a = 0; a < spans.length; a++) {
      for (let b = a + 1; b < spans.length; b++) {
        const overlaps = spans[a][0] < spans[b][1] && spans[b][0] < spans[a][1];
        assert.ok(!overlaps, `${item.videoId} source spans overlap`);
      }
    }
  }
});

test("segment offsets index the cleaned source text exactly", () => {
  for (const item of artifact.items) {
    if (!item.segments?.length) continue;
    for (const segment of item.segments) {
      assert.equal(
        item.sourceText.slice(segment.start, segment.end).trim(),
        segment.text.trim(),
        `${item.videoId}/${segment.role} does not match its source span`,
      );
    }
  }
});

test("the legend matches the brief: solid ink fact, dotted ochre meaning, filled verdict", async () => {
  const result = await run(`{
    entryPage(limit: 6) { segments { role style { underline tone fill className legend description } } }
  }`);
  assert.deepEqual(result.errors, undefined);
  const seen = new Map<string, any>();
  for (const item of result.data.entryPage) {
    for (const segment of item.segments) {
      const previous = seen.get(segment.role);
      if (previous) assert.deepEqual(JSON.parse(JSON.stringify(segment.style)), JSON.parse(JSON.stringify(previous)), `${segment.role} style is inconsistent between cards`);
      seen.set(segment.role, segment.style);
    }
  }
  // GraphQL returns null-prototype objects; compare plain values.
  const plain = (value: any) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(seen.get("FACT")), LEGEND.FACT);
  assert.deepEqual(plain(seen.get("MEANING")), LEGEND.MEANING);
  assert.deepEqual(plain(seen.get("VERDICT")), LEGEND.VERDICT);
  assert.equal(seen.get("FACT").underline, "solid");
  assert.equal(seen.get("FACT").tone, "ink");
  assert.equal(seen.get("MEANING").underline, "dotted");
  assert.equal(seen.get("MEANING").tone, "ochre");
  assert.equal(seen.get("VERDICT").fill, true);
  assert.ok(seen.get("FACT").legend.startsWith("1 ·"));
  assert.ok(seen.get("MEANING").legend.startsWith("2 ·"));
  assert.ok(seen.get("VERDICT").legend.startsWith("3 ·"));
});

test("an anatomy never repeats another segment's text", async () => {
  const result = await run(`{ entryPage(limit: 6) { videoId segments { role text } } }`);
  for (const item of result.data.entryPage) {
    const texts = item.segments.map((segment: any) => segment.text);
    assert.equal(new Set(texts).size, texts.length, `${item.videoId} duplicates a segment`);
  }
  // And the whole artifact, not just the entry page.
  for (const item of artifact.items) {
    const texts = (item.segments ?? []).map((segment: any) => segment.text);
    assert.equal(new Set(texts).size, texts.length, `${item.videoId} duplicates a segment`);
  }
});

test("anatomy(videoId) resolves any id and returns null for an unknown one", async () => {
  const sample = artifact.items.find((item: any) => item.coverage === "full");
  const result = await run(`query($id: ID!) {
    anatomy(videoId: $id) {
      videoId composed quality coverage
      attribution { handle url platform }
      video { id verdicts { candidate { id } leaning } }
    }
  }`, { id: sample.videoId });
  assert.deepEqual(result.errors, undefined);
  assert.equal(result.data.anatomy.videoId, sample.videoId);
  assert.equal(result.data.anatomy.composed, sample.composed);
  assert.equal(result.data.anatomy.video.id, sample.videoId);

  const missing = await run(`{ anatomy(videoId: "cnt_nope") { videoId } }`);
  assert.equal(missing.data.anatomy, null);
});

test("buildAnatomy is deterministic and never invents text", () => {
  const sample = artifact.items.find((item: any) => item.coverage === "full");
  const first = buildAnatomy(index, sample.videoId, dataset.facts)!;
  const second = buildAnatomy(index, sample.videoId, dataset.facts)!;
  assert.deepEqual(first, second);
  const video = index.videoById.get(sample.videoId)!;
  const source = cleanText((video.transcript ?? "").length >= 80 ? video.transcript! : (video.caption || (video.on_screen_text ?? []).join(" \n ")));
  for (const segment of first.segments) {
    assert.ok(source.includes(segment.text), `${segment.role} text is not a substring of the source`);
  }
});

test("entry selection is stable and ordered by quality then reach", () => {
  const a = selectEntry(index, 6).map((item) => item.videoId);
  const b = selectEntry(index, 6).map((item) => item.videoId);
  assert.deepEqual(a, b);
  const qualities = selectEntry(index, 6).map((item) => item.anatomy.quality);
  assert.ok(qualities.every((quality) => quality >= 0.6));
});
