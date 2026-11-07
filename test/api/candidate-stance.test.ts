/**
 * Invariants for data/analyses/candidate-stance.json — the Gemini pass over the
 * per-candidate snapshot. Offline: no model calls, no Oriane calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { CANDIDATES_BY_ID } from "../../supabase/functions/_shared/candidates.ts";

const PATH = "data/analyses/candidate-stance.json";
const skip = existsSync(PATH) ? false : "run `npm run stance:candidates` first";

const load = () => JSON.parse(readFileSync(PATH, "utf8"));

test("candidate stance artifact covers every candidate file", { skip }, () => {
  const data = load();
  assert.ok(data.generatedAt);
  assert.ok(data.candidates.length >= 30, `expected 30+ candidates, got ${data.candidates.length}`);
  assert.ok(data.videos.length >= 250, `expected 250+ video×candidate rows, got ${data.videos.length}`);
  assert.ok(data.creators.length > 100);
  assert.equal(data.method.pairs, data.videos.length);
  assert.ok(data.method.model, "the artifact must record which model produced it");
});

test("each candidate's stance buckets add up and indexes are consistent", { skip }, () => {
  const data = load();
  for (const row of data.candidates) {
    assert.equal(
      row.favorable + row.critical + row.neutral + row.unclear,
      row.videos,
      `${row.candidate_id} buckets must sum to videos`,
    );
    assert.equal(
      row.stance_index,
      Number(((row.favorable - row.critical) / Math.max(row.videos, 1)).toFixed(3)),
      `${row.candidate_id} stance_index`,
    );
    assert.equal(
      row.coverage,
      Number((((row.videos - row.unclear) / Math.max(row.videos, 1))).toFixed(3)),
      `${row.candidate_id} coverage`,
    );
    assert.ok(row.view_weighted_index >= -1 && row.view_weighted_index <= 1);
    assert.ok(row.avg_score >= -1 && row.avg_score <= 1);
    assert.ok(row.creators >= 1);
    assert.ok(CANDIDATES_BY_ID[row.candidate_id], `unknown candidate ${row.candidate_id}`);
  }
});

test("the evidence contract holds: no stance without a supported quote", { skip }, () => {
  const data = load();
  for (const row of data.videos) {
    // A directional label always carries evidence.
    if (row.label === "favorable" || row.label === "critical") {
      assert.ok(row.quote && row.quote.length > 0, `${row.video_id}/${row.candidate_id} has a stance but no quote`);
      assert.ok(
        !row.basis.includes("unverified"),
        `${row.video_id}/${row.candidate_id} was labelled from an unverified model quote`,
      );
      // Model-derived labels must record how the quote was verified. The
      // deterministic lexicon path carries its own sliced quote instead.
      if (row.basis.startsWith("gemini:")) {
        assert.ok(
          ["exact", "fuzzy"].includes(row.evidence_mode),
          `${row.video_id}/${row.candidate_id} model stance without a verified evidence mode`,
        );
      }
    }
    // A neutral assigned by the relevance rule has no quote by design: the
    // candidate appears as one row in a list, so there is no stance sentence.
    if (row.label === "neutral" && !row.quote) {
      assert.ok(
        row.basis.startsWith("relevance:"),
        `${row.video_id}/${row.candidate_id} neutral without a quote must come from the relevance rule`,
      );
      assert.equal(row.score, 0);
    }
    // Unclear never carries a direction.
    if (row.label === "unclear") assert.equal(row.score, 0);
    // A rejected model verdict never becomes a label.
    if (row.basis.includes("unverified")) assert.equal(row.label, "unclear");
  }
});

test("every row is scoped to a real candidate and a real video", { skip }, () => {
  const data = load();
  const seen = new Set<string>();
  for (const row of data.videos) {
    assert.ok(CANDIDATES_BY_ID[row.candidate_id], `unknown candidate ${row.candidate_id}`);
    assert.ok(row.video_id.startsWith("cnt_"), `bad video id ${row.video_id}`);
    assert.ok(row.url.startsWith("https://"), `${row.video_id} missing url`);
    const key = `${row.video_id}|${row.candidate_id}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
    assert.ok(row.score >= -1 && row.score <= 1);
    assert.ok(["favorable", "critical", "neutral", "unclear"].includes(row.label));
  }
});

test("creator rows reconcile with the video rows", { skip }, () => {
  const data = load();
  const counted = new Map<string, number>();
  for (const row of data.videos) {
    const key = `${row.creator_handle}|${row.candidate_id}`;
    counted.set(key, (counted.get(key) ?? 0) + 1);
  }
  for (const row of data.creators) {
    const key = `${row.creator_handle}|${row.candidate_id}`;
    assert.equal(row.videos, counted.get(key), `creator row ${key} video count`);
    assert.equal(row.favorable + row.critical + row.neutral + row.unclear, row.videos);
    if (row.videos < 2) assert.equal(row.label, "single_video");
  }
});

test("the batched run stays inside its call budget", { skip }, () => {
  const data = load();
  assert.ok(
    data.method.modelCalls <= data.method.uniqueVideos,
    "one call per video is the ceiling",
  );
  assert.equal(data.method.modelFailures, 0, "no failed model calls in the shipped artifact");
});
