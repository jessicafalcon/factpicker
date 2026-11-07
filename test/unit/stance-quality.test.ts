import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessRelevance,
  matchEvidence,
  FEW_SHOT_EXAMPLES,
  FEW_SHOT_INSTRUCTION,
} from "../../supabase/functions/_shared/stance-quality.ts";
import { cosine, scoreAnchors, textFingerprint, STANCE_ANCHORS } from "../../supabase/functions/_shared/embeddings.ts";
import { CANDIDATES_BY_ID } from "../../supabase/functions/_shared/candidates.ts";
import type { VideoRow } from "../../supabase/functions/_shared/types.ts";

function video(overrides: Partial<VideoRow>): VideoRow {
  return {
    id: "cnt_t",
    platform: "tiktok",
    platform_id: "1",
    url: "https://www.tiktok.com/@x/video/1",
    creator_handle: "testeur",
    creator_display_name: null,
    creator_followers: 1,
    creator_verified: null,
    posted_at: "2026-10-01T00:00:00.000Z",
    views: 1,
    likes: 0,
    shares: 0,
    comments: 0,
    interactions: 0,
    title: null,
    caption: null,
    caption_language: "fr",
    transcript: null,
    transcript_language: "fr",
    on_screen_text: [],
    visual_tags: [],
    platform_format: "video",
    format: "talking",
    duration_seconds: 10,
    thumbnail_url: null,
    is_french: true,
    party_signals: [],
    source: "oriane",
    ...overrides,
  };
}

test("relevance: absent when the candidate is not in the text", () => {
  const relevance = assessRelevance(
    video({ caption: "Les pompiers manifestent à Paris pour plus de moyens." }),
    CANDIDATES_BY_ID.batho,
  );
  assert.equal(relevance.mentioned, false);
  assert.equal(relevance.kind, "absent");
});

test("relevance: a list of candidates is a listicle, not a stance", () => {
  const caption =
    "La liste des 30 candidats déjà déclarés : Bernard Cazeneuve (La Convention), Karim Bouamrane (PS), " +
    "David Lisnard (Nouvelle Énergie), Marine Tondelier (Les Écologistes), Éric Zemmour (Reconquête), " +
    "Fabien Roussel (PCF), François Ruffin (Debout!), Nicolas Dupont-Aignan (DLF).";
  const relevance = assessRelevance(video({ caption }), CANDIDATES_BY_ID.cazeneuve);
  assert.equal(relevance.kind, "listicle");
  assert.ok(relevance.candidatesInText >= 5);
});

test("relevance: a namesake surname needs first-name corroboration", () => {
  const namesake = assessRelevance(
    video({ caption: "PIERRE CAZENEUVE, député Ensemble pour la République, prend la parole." }),
    CANDIDATES_BY_ID.cazeneuve,
  );
  assert.equal(namesake.kind, "namesake_risk");

  const genuine = assessRelevance(
    video({ caption: "Bernard Cazeneuve annonce sa candidature à l'élection présidentielle." }),
    CANDIDATES_BY_ID.cazeneuve,
  );
  assert.equal(genuine.kind, "direct");
});

test("relevance: distinctive surnames do not need the first name", () => {
  const relevance = assessRelevance(
    video({ caption: "Mélenchon dénonce la réforme des retraites devant la foule." }),
    CANDIDATES_BY_ID.melenchon,
  );
  assert.equal(relevance.kind, "direct");
});

test("evidence: exact quotes verify as exact", () => {
  const match = matchEvidence("Marine Le Pen est dangereuse", video({ caption: "Marine Le Pen est dangereuse." }));
  assert.equal(match.verified, true);
  assert.equal(match.mode, "exact");
  assert.equal(match.source, "caption");
});

test("evidence: a paraphrase verifies against the source sentence as fuzzy", () => {
  const match = matchEvidence(
    "Elle a refusé de soutenir les revendications et accusé les casseurs",
    video({ caption: "Marine Le Pen a refusé de soutenir les revendications et a accusé les casseurs du salon." }),
  );
  assert.equal(match.verified, true);
  assert.equal(match.mode, "fuzzy");
  assert.ok(match.similarity >= 0.7);
  assert.ok(match.sentence && match.sentence.length > 0);
});

test("evidence: an invented quote never verifies and returns no sentence match", () => {
  const match = matchEvidence(
    "Le candidat veut nationaliser les banques",
    video({ caption: "Les pompiers manifestent à Paris pour plus de moyens." }),
  );
  assert.equal(match.verified, false);
  assert.equal(match.mode, "none");
  assert.equal(match.source, null);
});

test("evidence: an empty quote is rejected", () => {
  const match = matchEvidence("", video({ caption: "Marine Le Pen est dangereuse" }));
  assert.equal(match.verified, false);
  assert.equal(match.mode, "none");
});

test("few-shot exemplars are valid JSON and cover the four registers", () => {
  let favorable = 0;
  let critical = 0;
  let neutral = 0;
  for (const example of FEW_SHOT_EXAMPLES) {
    const parsed = JSON.parse(example.output);
    assert.ok(["favorable", "critical", "neutral", "unclear"].includes(parsed.stance));
    assert.ok(typeof parsed.evidence_quote === "string" && parsed.evidence_quote.length > 0);
    if (parsed.stance === "favorable") favorable++;
    if (parsed.stance === "critical") critical++;
    if (parsed.stance === "neutral") neutral++;
  }
  assert.ok(favorable >= 1 && critical >= 1 && neutral >= 2);
  assert.ok(FEW_SHOT_INSTRUCTION.includes("Example 1"));
});

test("embeddings: cosine is bounded and symmetric", () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosine([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(cosine([1, 0, 0], [-1, 0, 0]), -1);
  assert.equal(cosine([0, 0, 0], [1, 0, 0]), 0);
  assert.equal(cosine([1, 2], [1, 2]), cosine([1, 2], [1, 2]));
});

test("embeddings: anchor scoring prefers the dominant family", () => {
  const favorable = scoreAnchors([
    { family: "favorable", value: 0.5 },
    { family: "favorable", value: 0.48 },
    { family: "critical", value: 0.2 },
    { family: "critical", value: 0.18 },
    { family: "neutral", value: 0.3 },
    { family: "neutral", value: 0.29 },
  ]);
  assert.equal(favorable.label, "favorable");
  assert.ok(favorable.score > 0);

  const critical = scoreAnchors([
    { family: "favorable", value: 0.2 },
    { family: "critical", value: 0.55 },
    { family: "neutral", value: 0.25 },
  ]);
  assert.equal(critical.label, "critical");

  const neutral = scoreAnchors([
    { family: "favorable", value: 0.3 },
    { family: "critical", value: 0.29 },
    { family: "neutral", value: 0.52 },
  ]);
  assert.equal(neutral.label, "neutral");
});

test("embeddings: fingerprints normalise case and accents for dedupe", () => {
  const a = video({ caption: "MÉLENCHON dénonce la réforme !" });
  const b = video({ caption: "melenchon denonce la reforme" });
  assert.equal(textFingerprint(a), textFingerprint(b));
  assert.ok(Object.keys(STANCE_ANCHORS).length === 3);
});
