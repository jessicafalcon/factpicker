/**
 * Invariants over the scraped dataset in data/oriane/.
 *
 * These run offline and are the guard rail for the demo: if the pull is rerun
 * with a broken dictionary or a bad query shape, this fails before the UI does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { CANDIDATES, CANDIDATES_BY_ID } from "../../supabase/functions/_shared/candidates.ts";

const DATASET = "data/oriane/top10-all.json";
const hasDataset = existsSync(DATASET);
const skip = hasDataset ? false : "run `npm run pull:top10` first";

function load(): any {
  return JSON.parse(readFileSync(DATASET, "utf8"));
}

test("dataset exists with real volume", { skip }, () => {
  const data = load();
  assert.ok(data.generatedAt);
  assert.ok(data.candidates.length >= 30, "all declared candidates should be present");
  assert.ok(data.videos.length >= 150, `expected 150+ unique videos, got ${data.videos.length}`);
  assert.ok(data.mentions.length >= data.videos.length, "each video should yield at least one mention");
  assert.ok(data.stats.french / data.videos.length >= 0.9, "the demo is French-only");
  assert.ok(data.stats.imagePosts > 0, "image posts must be represented");
});

test("every pulled candidate has a per-candidate file and a summary row", { skip }, () => {
  const data = load();
  const files = new Set(readdirSync("data/oriane").filter((file) => file.endsWith(".json")));
  for (const candidate of data.candidates) {
    assert.ok(files.has(`${candidate.id}.json`), `missing data/oriane/${candidate.id}.json`);
    assert.ok(CANDIDATES_BY_ID[candidate.id], `unknown candidate id ${candidate.id}`);
  }
});

test("video rows are well formed and unique", { skip }, () => {
  const data = load();
  const ids = new Set<string>();
  for (const video of data.videos) {
    assert.ok(video.id.startsWith("cnt_"), `bad id ${video.id}`);
    assert.ok(!ids.has(video.id), `duplicate video ${video.id}`);
    ids.add(video.id);

    assert.ok(["instagram", "tiktok", "youtube"].includes(video.platform));
    assert.ok(video.platform_id, `${video.id} missing platform_id`);
    assert.ok(video.url?.startsWith("https://"), `${video.id} missing url`);

    if (video.platform === "youtube") {
      assert.match(video.url, /youtube\.com\/(watch\?v=|shorts\/)[\w-]+/);
    } else if (video.platform === "tiktok") {
      assert.match(video.url, /tiktok\.com\/@[\w.]+\/video\/\d+/);
    } else {
      assert.match(video.url, /instagram\.com\/(p|reel)\/[\w-]+\//);
    }

    assert.ok(["talking", "image_post"].includes(video.format));
    assert.ok(video.caption || video.transcript || video.on_screen_text.length > 0, `${video.id} has no text at all`);
    assert.equal(video.source, "oriane");
    for (const key of ["views", "likes", "interactions", "creator_followers"]) {
      const value = video[key];
      assert.ok(value === null || typeof value === "number", `${video.id} ${key} is not numeric`);
    }
  }
});

test("mentions reference known candidates and carry usable provenance", { skip }, () => {
  const data = load();
  const videos = new Map(data.videos.map((video: any) => [video.id, video]));

  for (const mention of data.mentions) {
    assert.ok(CANDIDATES_BY_ID[mention.candidate_id], `unknown candidate ${mention.candidate_id}`);
    assert.ok(["caption", "transcript", "on_screen_text"].includes(mention.source_field));
    assert.ok(["strong", "weak"].includes(mention.strength));
    assert.ok(mention.matched_terms.length > 0);
    assert.ok(videos.has(mention.video_id), `mention points at unknown video ${mention.video_id}`);

    const video: any = videos.get(mention.video_id);
    const source =
      mention.source_field === "caption"
        ? video.caption ?? ""
        : mention.source_field === "transcript"
          ? video.transcript ?? ""
          : (video.on_screen_text ?? [])[Number(mention.source_key?.match(/\[(\d+)\]/)?.[1] ?? 0)] ?? "";

    assert.ok(source.length > 0, `${mention.video_id}/${mention.source_key} has no source text`);
    for (const occurrence of mention.occurrences) {
      assert.ok(occurrence.start >= 0 && occurrence.end <= source.length, "occurrence out of bounds");
      assert.ok(occurrence.end > occurrence.start, "empty occurrence");
    }
  }
});

test("strong mentions always use a full-name alias", { skip }, () => {
  const data = load();
  for (const mention of data.mentions.filter((m: any) => m.strength === "strong")) {
    const candidate = CANDIDATES_BY_ID[mention.candidate_id];
    const strongTerms = new Set(candidate.aliases.map((alias) => alias.toLowerCase()));
    const hasStrong = mention.matched_terms.some((term: string) => strongTerms.has(term.toLowerCase()));
    assert.ok(hasStrong, `${mention.candidate_id} strong mention without a full-name term: ${mention.matched_terms}`);
  }
});

test("the dictionary matches the declared candidate roster", () => {
  const declared = CANDIDATES.filter((candidate) => candidate.status === "declared");
  assert.ok(declared.length >= 30, `expected 30+ declared candidates, got ${declared.length}`);
  // Bardella is deliberately present without being a declared candidate.
  const bardella = CANDIDATES_BY_ID.bardella;
  assert.ok(bardella);
  assert.notEqual(bardella.status, "declared");
  // Polony is a declared journalist, not a party candidate: the UI needs the note.
  assert.ok(CANDIDATES_BY_ID.polony.statusNote?.includes("Journalist"));
});
