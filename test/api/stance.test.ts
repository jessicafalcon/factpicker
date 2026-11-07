/**
 * Invariants over the stance artifacts in data/analyses/.
 *
 * Offline, no model calls. They guard the aggregation arithmetic and the
 * evidence contract, which are the two things a journalist will challenge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { CANDIDATES_BY_ID } from "../../supabase/functions/_shared/candidates.ts";

const STANCE = "data/analyses/creator-stance.json";
const SNAPSHOT = "data/oriane/top10-all.json";
const hasData = existsSync(STANCE) && existsSync(SNAPSHOT);
const skip = hasData ? false : "run `npm run stance` after `npm run pull:top10`";

function load(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const LABELS = new Set([
  "favorable", "leaning_favorable", "mixed", "leaning_critical",
  "critical", "no_signal", "single_video", "insufficient",
]);
const VIDEO_LABELS = new Set(["favorable", "critical", "neutral", "unclear"]);

test("stance artifact exists with real coverage", { skip }, () => {
  const data = load(STANCE);
  assert.ok(data.generatedAt);
  assert.ok(data.rows.length > 100, `expected 100+ creator×candidate rows, got ${data.rows.length}`);
  assert.ok(data.perVideo.length > 300, `expected 300+ video×candidate scores, got ${data.perVideo.length}`);
  assert.ok(Object.keys(data.stats).length > 5);
  assert.equal(data.stats.modelCalls, 0, "the reproducible artifact must not depend on model calls");
});

test("every creator row adds up", { skip }, () => {
  const data = load(STANCE);
  for (const row of data.rows) {
    assert.equal(
      row.favorable + row.critical + row.neutral + row.unclear,
      row.videos,
      `${row.creator_handle}/${row.candidate_id} buckets must sum to videos`,
    );
    assert.equal(
      row.stance_index,
      Number(((row.favorable - row.critical) / Math.max(row.videos, 1)).toFixed(3)),
      "stance_index must be (favorable - critical) / videos",
    );
    assert.ok(LABELS.has(row.label), `unknown label ${row.label}`);
    assert.ok(CANDIDATES_BY_ID[row.candidate_id], `unknown candidate ${row.candidate_id}`);
    assert.ok(row.creator_handle.length > 0);
    assert.ok(row.total_views >= 0);
    if (row.label === "single_video") assert.equal(row.videos, 1);
    if (row.label === "insufficient") assert.ok(row.videos < 2);
  }
});

test("per-video rows are unique, labelled and scoped to real candidates", { skip }, () => {
  const data = load(STANCE);
  const seen = new Set<string>();
  for (const row of data.perVideo) {
    const key = `${row.video_id}|${row.candidate_id}`;
    assert.ok(!seen.has(key), `duplicate pair ${key}`);
    seen.add(key);
    assert.ok(VIDEO_LABELS.has(row.label), `unknown video label ${row.label}`);
    assert.ok(CANDIDATES_BY_ID[row.candidate_id], `unknown candidate ${row.candidate_id}`);
    assert.ok(row.score >= -1 && row.score <= 1, `score out of range: ${row.score}`);
    if (row.label === "unclear") {
      assert.equal(row.score, 0, "an unclear video carries no directional score");
    } else {
      assert.ok(row.markers.length > 0, "a labelled video must carry markers");
    }
  }
});

test("every mention of a known candidate produces a stance row", { skip }, () => {
  const snapshot = load(SNAPSHOT);
  const data = load(STANCE);
  const scored = new Set(data.perVideo.map((row: any) => `${row.video_id}|${row.candidate_id}`));
  const pairs = new Set(
    snapshot.mentions
      .filter((mention: any) => CANDIDATES_BY_ID[mention.candidate_id])
      .map((mention: any) => `${mention.video_id}|${mention.candidate_id}`),
  );
  for (const pair of pairs) {
    assert.ok(scored.has(pair), `missing stance for ${pair}`);
  }
});

test("evidence quotes are non-empty and come from the video text", { skip }, () => {
  const snapshot = load(SNAPSHOT);
  const videos = new Map(snapshot.videos.map((video: any) => [video.id, video]));
  const data = load(STANCE);

  for (const row of data.perVideo.filter((entry: any) => entry.label !== "unclear")) {
    const video: any = videos.get(row.video_id);
    assert.ok(video, `unknown video ${row.video_id}`);
    assert.ok(row.quote.length > 0, "labelled rows need an evidence quote");

    const haystack = [video.caption ?? "", video.transcript ?? "", (video.on_screen_text ?? []).join("\n")]
      .join("\n")
      .toLowerCase();
    // The quote is built from a slice of the source text, so its first words
    // must appear in the video.
    const probe = row.quote.split(" … ")[0].trim().slice(0, 40).toLowerCase();
    assert.ok(haystack.includes(probe), `quote not found in source for ${row.video_id}: ${probe}`);
  }
});

test("the deterministic layer refuses to label from a single video", { skip }, () => {
  const data = load(STANCE);
  const decisive = data.rows.filter((row: any) =>
    ["favorable", "leaning_favorable", "mixed", "leaning_critical", "critical"].includes(row.label),
  );
  for (const row of decisive) assert.ok(row.videos >= 2, `${row.creator_handle} labelled from ${row.videos} video(s)`);
});

test("creator totals reconcile with the per-candidate rows", { skip }, () => {
  const data = load(STANCE);
  const totals = new Map(data.creatorTotals.map((entry: any) => [entry.creator_handle, entry]));
  const summed = new Map<string, number>();
  for (const row of data.rows) {
    summed.set(row.creator_handle, (summed.get(row.creator_handle) ?? 0) + row.videos);
  }
  for (const [handle, videos] of summed) {
    assert.equal((totals.get(handle) as any).videos, videos, `creatorTotals mismatch for ${handle}`);
  }
});
