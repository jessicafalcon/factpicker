import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateCreatorStance,
  buildTextBundle,
  describeStance,
  findMarkers,
  scoreCandidateInBundle,
  scoreVideoForCandidate,
  LEXICON,
} from "../../supabase/functions/_shared/sentiment.ts";
import { shouldEscalate, buildVertexPrompt } from "../../supabase/functions/_shared/vertex.ts";
import { CANDIDATES, CANDIDATES_BY_ID } from "../../supabase/functions/_shared/candidates.ts";
import type { VideoRow } from "../../supabase/functions/_shared/types.ts";

function video(overrides: Partial<VideoRow>): VideoRow {
  return {
    id: "cnt_test",
    platform: "tiktok",
    platform_id: "1",
    url: "https://www.tiktok.com/@x/video/1",
    creator_handle: "testeur",
    creator_display_name: "Testeur",
    creator_followers: 1000,
    creator_verified: false,
    posted_at: "2026-10-01T00:00:00.000Z",
    views: 1000,
    likes: 10,
    shares: 0,
    comments: 0,
    interactions: 10,
    title: null,
    caption: null,
    caption_language: "fr",
    transcript: null,
    transcript_language: "fr",
    on_screen_text: [],
    visual_tags: [],
    platform_format: "video",
    format: "talking",
    duration_seconds: 30,
    thumbnail_url: null,
    is_french: true,
    party_signals: [],
    source: "oriane",
    ...overrides,
  };
}

test("lexicon matching is accent-insensitive", () => {
  const bundle = buildTextBundle(video({ caption: "Mélenchon dénonce la réforme, honte à ce gouvernement" }), ["caption"]);
  const terms = findMarkers(bundle).map((marker) => marker.term);
  assert.ok(terms.includes("denonce"));
  assert.ok(terms.includes("honte"));
});

test("negation flips polarity", () => {
  const positive = scoreCandidateInBundle(
    buildTextBundle(video({ caption: "Marine Le Pen est dangereuse" }), ["caption"]),
    CANDIDATES_BY_ID.lepen,
  );
  const negated = scoreCandidateInBundle(
    buildTextBundle(video({ caption: "Marine Le Pen n'est pas dangereuse" }), ["caption"]),
    CANDIDATES_BY_ID.lepen,
  );
  assert.ok(positive.score < 0);
  assert.ok(negated.score > 0);
});

test("a marker in another sentence is not attributed to the candidate", () => {
  const bundle = buildTextBundle(
    video({ caption: "Édouard Philippe était au Havre. La cathédrale est magnifique." }),
    ["caption"],
  );
  const score = scoreCandidateInBundle(bundle, CANDIDATES_BY_ID.philippe);
  assert.equal(score.unclear, true, "praise for a cathedral must not score the candidate");
});

test("the candidate as the subject of an attack verb is not scored as a target", () => {
  const bundle = buildTextBundle(
    video({ caption: "Natacha Polony dénonce l'excès de zèle de nos acheteurs publics." }),
    ["caption"],
  );
  const score = scoreCandidateInBundle(bundle, CANDIDATES_BY_ID.polony);
  assert.equal(score.unclear, true);
});

test("the candidate as the object of an attack verb is scored", () => {
  const bundle = buildTextBundle(
    video({ caption: "Darmanin accuse Marine Le Pen de mollesse sur l'islam." }),
    ["caption"],
  );
  const score = scoreCandidateInBundle(bundle, CANDIDATES_BY_ID.lepen);
  assert.notEqual(score.score, 0);
});

test("hashtag intent counts only with a name token and an intent word", () => {
  const supported = scoreCandidateInBundle(
    buildTextBundle(video({ caption: "Trop fière. #avecmarine #marine2027" }), ["caption"]),
    CANDIDATES_BY_ID.lepen,
  );
  assert.ok(supported.score > 0);
  assert.ok(supported.markers.some((marker) => marker.term.startsWith("#")));

  const unrelated = scoreCandidateInBundle(
    buildTextBundle(video({ caption: "Regardez cette méduse. #marinebiology" }), ["caption"]),
    CANDIDATES_BY_ID.lepen,
  );
  assert.equal(unrelated.unclear, true);
});

test("scoring falls back to the transcript and says so", () => {
  const score = scoreVideoForCandidate(
    video({ caption: "Suite du direct.", transcript: "Marine Le Pen est une menteuse, elle a trahi la France." }),
    CANDIDATES_BY_ID.lepen,
    CANDIDATES,
  );
  assert.equal(score.basis, "transcript_fallback");
  assert.ok(score.score < 0);
});

test("aggregation counts, indexes and labels stay consistent", () => {
  const videos = [
    video({ id: "cnt_1", caption: "Je vote pour Marine Le Pen, courage à elle." }),
    video({ id: "cnt_2", caption: "Marine Le Pen est la seule capable de rassembler." }),
    video({ id: "cnt_3", caption: "Marine Le Pen est une menteuse, honte à elle." }),
  ];
  const mentions = videos.map((item) => ({ video_id: item.id, candidate_id: "lepen", strength: "strong" }));

  const { rows, perVideo } = aggregateCreatorStance(videos, mentions, CANDIDATES, { minVideos: 2 });
  assert.equal(perVideo.length, 3);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.videos, 3);
  assert.equal(row.favorable + row.critical + row.neutral + row.unclear, 3);
  assert.equal(
    row.stance_index,
    Number(((row.favorable - row.critical) / row.videos).toFixed(3)),
  );
  assert.ok(["favorable", "leaning_favorable", "mixed", "leaning_critical", "critical"].includes(row.label));
  assert.ok(row.evidence.length > 0);
  assert.ok(describeStance(row).includes("out of 3 videos"));
});

test("a single video never characterises the handle", () => {
  const videos = [video({ id: "cnt_solo", caption: "Je vote pour Marine Le Pen." })];
  const { rows } = aggregateCreatorStance(
    videos,
    [{ video_id: "cnt_solo", candidate_id: "lepen", strength: "strong" }],
    CANDIDATES,
    { minVideos: 2 },
  );
  assert.equal(rows[0].label, "single_video");
  assert.ok(describeStance(rows[0]).includes("not characterised"));
});

test("overrides replace the deterministic score", () => {
  const videos = [video({ id: "cnt_o", caption: "Bla bla." })];
  const mentions = [{ video_id: "cnt_o", candidate_id: "lepen", strength: "strong" }];
  const overrides = new Map([["cnt_o|lepen", { score: -0.8, basis: "vertex:test", markers: ["critical"], quote: "Bla bla." }]]);
  const { rows } = aggregateCreatorStance(videos, mentions, CANDIDATES, { minVideos: 1, overrides });
  assert.equal(rows[0].critical, 1);
  assert.equal(rows[0].label, "critical");
});

test("escalation policy only spends model calls on ambiguous videos", () => {
  assert.equal(shouldEscalate({ unclear: true, positive: 0, negative: 0 }).escalate, true);
  assert.equal(shouldEscalate({ unclear: false, positive: 2, negative: 2 }).escalate, true);
  assert.equal(shouldEscalate({ unclear: false, positive: 3, negative: 1 }).escalate, false);
  assert.equal(shouldEscalate({ unclear: false, positive: 4, negative: 0 }).escalate, false);
});

test("the Vertex prompt carries the evidence contract", () => {
  const prompt = buildVertexPrompt({ candidateName: "Marine Le Pen", handle: "x", caption: "c", onScreenText: [] });
  assert.ok(prompt.includes("evidence_quote"));
  assert.ok(prompt.includes("favorable|critical|neutral|unclear"));
  assert.ok(prompt.toLowerCase().includes("never the person"));
});

test("the lexicon has no duplicate terms and no descriptive ideology labels", () => {
  const terms = LEXICON.map((entry) => entry.term);
  assert.equal(new Set(terms).size, terms.length);
  for (const banned of ["extreme droite", "extreme gauche", "communiste", "nationaliste"]) {
    assert.ok(!terms.includes(banned), `${banned} must not drive a stance`);
  }
  for (const entry of LEXICON) {
    assert.ok(["positive", "negative"].includes(entry.polarity));
    assert.ok(entry.weight > 0 && entry.weight <= 3);
  }
});
