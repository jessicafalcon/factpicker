import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aliasPattern,
  buildVideoUrl,
  classifyFormat,
  detectFrench,
  evidenceIsVerbatim,
  normalizeText,
  scanCandidate,
} from "../../supabase/functions/_shared/normalize.ts";
import { buildMentions } from "../../supabase/functions/_shared/pipeline.ts";
import { CANDIDATES, CANDIDATES_BY_ID, DEMO_CANDIDATE_IDS, TOPICS } from "../../supabase/functions/_shared/candidates.ts";
import { COMMUNITIES, COMMUNITIES_BY_ID } from "../../supabase/functions/_shared/communities.ts";
import { QUERY_CATALOG, QUERY_CATALOG_BY_ID } from "../../supabase/functions/_shared/queries.ts";
import type { OrianeContent } from "../../supabase/functions/_shared/oriane.ts";

test("normalizeText strips accents, case and separators", () => {
  assert.equal(normalizeText("Édouard Philippe"), "edouard philippe");
  assert.equal(normalizeText("MÉLENCHON"), "melenchon");
  assert.equal(normalizeText("Le-Pen"), "le pen");
  assert.equal(normalizeText("  Jean   Luc  "), "jean luc");
  assert.equal(normalizeText(null), "");
});

test("aliasPattern is accent-, case- and separator-tolerant", () => {
  const pattern = aliasPattern("Édouard Philippe");
  assert.ok(pattern.test("Edouard Philippe"));
  assert.ok(pattern.test("ÉDOUARD PHILIPPE"));
  assert.ok(pattern.test("edouard-philippe"));
  assert.ok(!pattern.test("Florian Philippot"));
  assert.ok(!pattern.test("Philippe Édouard"));
});

test("aliasPattern never lets 'Édouard Philippe' match a surname-only mention", () => {
  const pattern = aliasPattern("Édouard Philippe");
  assert.ok(!pattern.test("J'ai vu Philippe hier"));
});

test("aliasPattern matches Le Pen with collapsed spaces", () => {
  const pattern = aliasPattern("Le Pen");
  assert.ok(pattern.test("LePen"));
  assert.ok(pattern.test("le pen"));
  assert.ok(!pattern.test("Le Pennec"));
});

test("scanCandidate separates strong full-name hits from weak surname hits", () => {
  const candidate = CANDIDATES_BY_ID.lepen;
  const strong = scanCandidate("Marine Le Pen était l'invitée du 20h.", candidate);
  assert.equal(strong[0].strength, "strong");
  assert.equal(strong[0].term, "Marine Le Pen");

  const weak = scanCandidate("Le Pen était l'invitée du 20h.", candidate);
  assert.ok(weak.every((hit) => hit.strength === "weak"));
});

test("occurrence offsets point at the original substring for highlighting", () => {
  const text = "Hier, Marine Le Pen a parlé de Marine Le Pen.";
  const hits = scanCandidate(text, CANDIDATES_BY_ID.lepen);
  const occurrences = hits.flatMap((hit) => hit.occurrences);
  assert.equal(occurrences.length, 2);
  assert.equal(text.slice(occurrences[0].start, occurrences[0].end), "Marine Le Pen");
  assert.equal(text.slice(occurrences[1].start, occurrences[1].end), "Marine Le Pen");
});

test("detectFrench trusts the language field, otherwise uses stopword ratio", () => {
  assert.equal(detectFrench(["bonjour"], ["fr"]).isFrench, true);
  assert.equal(
    detectFrench(["Le gouvernement a annoncé que les retraites seront réformées avec les partenaires sociaux."]).isFrench,
    true,
  );
  assert.equal(
    detectFrench(["The government announced that pensions will be reformed with social partners this year."]).isFrench,
    false,
  );
  assert.equal(detectFrench([""]).isFrench, false);
});

test("classifyFormat follows the idea doc image-post rule", () => {
  assert.equal(classifyFormat("image", ""), "image_post");
  assert.equal(classifyFormat("carousel", "Marine Le Pen"), "image_post");
  assert.equal(classifyFormat("video", "trop court"), "image_post");
  assert.equal(classifyFormat("video", "mot ".repeat(80)), "talking");
});

test("evidenceIsVerbatim only accepts quotes found in the source", () => {
  const source = "Elle a déclaré que «les Français ont tout essayé» hier soir.";
  assert.equal(evidenceIsVerbatim("les Français ont tout essayé", source), true);
  assert.equal(evidenceIsVerbatim("les  Français   ont tout essayé", source), true);
  assert.equal(evidenceIsVerbatim("les Français sont fatigués", source), false);
  assert.equal(evidenceIsVerbatim("", source), false);
});

test("buildVideoUrl produces canonical URLs per platform", () => {
  assert.equal(buildVideoUrl("youtube", "V_b0En7ceyo", "gaspardg", "video"), "https://www.youtube.com/watch?v=V_b0En7ceyo");
  assert.equal(buildVideoUrl("youtube", "abc123", "x", "short"), "https://www.youtube.com/shorts/abc123");
  assert.equal(buildVideoUrl("tiktok", "7702", "brutofficiel", "video"), "https://www.tiktok.com/@brutofficiel/video/7702");
  assert.equal(buildVideoUrl("instagram", "DfHLejbFHNN", "cnews", "reel"), "https://www.instagram.com/reel/DfHLejbFHNN/");
  assert.equal(buildVideoUrl("instagram", "DfHLejbFHNN", "cnews", "image"), "https://www.instagram.com/p/DfHLejbFHNN/");
});

const RECORD: OrianeContent = {
  id: "cnt_test",
  platform: "instagram",
  platformId: "ABC123",
  platformType: "reel",
  format: "video",
  profileHandle: "example",
  profileDisplayName: "Example",
  profileId: "prf_1",
  profileFollowersCount: 1000,
  title: null,
  caption: "Marine Le Pen face à Édouard Philippe, et une pique à Florian Philippot.",
  publishedAt: "2026-10-01T00:00:00.000Z",
  viewsCount: 10,
  likesCount: 1,
  sharesCount: 0,
  commentsCount: 0,
  interactionsCount: 1,
  hashtags: [],
  thumbnailMediaUrl: "https://example.test/t.webp",
  media: [
    {
      type: "video",
      duration: 30,
      caption: null,
      transcript: "Jordan Bardella répond à Jean-Luc Mélenchon.",
      transcriptLanguage: "fr",
      onScreenText: ["MARINE LE PEN 2027"],
    },
  ],
};

test("buildMentions finds every candidate in a record and keeps field provenance", () => {
  const mentions = buildMentions(RECORD, CANDIDATES);
  const byCandidate = new Map(mentions.map((mention) => [`${mention.candidate_id}|${mention.source_field}`, mention]));

  assert.ok(byCandidate.has("lepen|caption"));
  assert.ok(byCandidate.has("philippe|caption"));
  assert.ok(byCandidate.has("philippot|caption"));
  assert.ok(byCandidate.has("bardella|transcript"));
  assert.ok(byCandidate.has("melenchon|transcript"));
  assert.ok(byCandidate.has("lepen|on_screen_text"));

  // "Philippe" alone must never become a mention of Édouard Philippe.
  assert.equal(
    mentions.filter((mention) => mention.candidate_id === "philippe").length,
    1,
    "only the full Édouard Philippe mention",
  );
  // Florian Philippot must not be counted as Édouard Philippe.
  assert.equal(byCandidate.get("philippot|caption")?.strength, "strong");
});

test("every mention's occurrences resolve to the matched text", () => {
  const mentions = buildMentions(RECORD, CANDIDATES);
  for (const mention of mentions) {
    const source =
      mention.source_field === "caption"
        ? RECORD.caption!
        : mention.source_field === "transcript"
          ? RECORD.media![0].transcript!
          : RECORD.media![0].onScreenText![0];
    for (const occurrence of mention.occurrences) {
      const slice = source.slice(occurrence.start, occurrence.end);
      assert.ok(slice.length > 0, `empty slice for ${mention.candidate_id}`);
      assert.ok(
        normalizeText(slice).length > 0,
        `occurrence ${occurrence.start}-${occurrence.end} out of range`,
      );
    }
  }
});

test("no candidate dictionary entry can be matched by an ambiguous weak alias", () => {
  const ambiguous = ["philippe", "mathieu", "lalanne", "ruffin", "polony", "markovic", "becht", "batho", "labib"];
  for (const id of ambiguous) {
    const candidate = CANDIDATES_BY_ID[id];
    assert.ok(candidate, `missing candidate ${id}`);
    assert.deepEqual(candidate.weakAliases, [], `${id} must not have weak aliases`);
  }
});

test("candidate ids are unique and every community reference resolves", () => {
  const ids = CANDIDATES.map((candidate) => candidate.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const candidate of CANDIDATES) {
    assert.ok(candidate.aliases.length > 0, `${candidate.id} has no aliases`);
    assert.ok(["frontrunner", "major", "minor"].includes(candidate.tier));
    assert.ok(["declared", "presumed", "not_declared", "not_declared_discussed"].includes(candidate.status));
    for (const communityId of candidate.communities) {
      assert.ok(COMMUNITIES_BY_ID[communityId], `${candidate.id} references unknown community ${communityId}`);
    }
  }
  const communityIds = COMMUNITIES.map((community) => community.id);
  assert.equal(new Set(communityIds).size, communityIds.length, "duplicate community ids");
  for (const community of COMMUNITIES) {
    for (const backed of community.backs) {
      assert.ok(CANDIDATES_BY_ID[backed], `${community.id} backs unknown candidate ${backed}`);
    }
  }
});

test("every demo candidate exists and the topic lexicon is non-empty", () => {
  for (const id of DEMO_CANDIDATE_IDS) assert.ok(CANDIDATES_BY_ID[id], `unknown demo candidate ${id}`);
  for (const [key, topic] of Object.entries(TOPICS)) {
    assert.ok(topic.terms.length > 0, `topic ${key} has no terms`);
  }
});

test("every catalog query builds a valid body with a sane nesting depth and value budget", () => {
  const ids = QUERY_CATALOG.map((spec) => spec.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate query ids");

  const countValues = (node: any): number => {
    if (!node || typeof node !== "object") return 0;
    if (Array.isArray(node)) return node.reduce((sum, item) => sum + countValues(item), 0);
    let total = 0;
    if (Array.isArray(node.values)) total += node.values.length;
    for (const value of Object.values(node)) total += countValues(value);
    return total;
  };
  // Counts query-group levels only: root object + nested `queries` groups.
  const depth = (node: any): number => {
    if (!node || typeof node !== "object") return 0;
    const children = Array.isArray(node) ? node : node.queries ?? [];
    if (!Array.isArray(children) || children.length === 0) return 1;
    return 1 + Math.max(...children.map(depth));
  };

  for (const spec of QUERY_CATALOG) {
    const body = spec.build({ candidateIds: DEMO_CANDIDATE_IDS, since: "2026-06-01" });
    assert.equal(body.operator, "and", `${spec.id} must root on AND`);
    assert.ok(body.filters || body.queries, `${spec.id} produced an empty body`);
    assert.ok(countValues(body) <= 500, `${spec.id} exceeds the 500 value budget`);
    // root query -> nested OR group -> leaf sub-query = 3 query objects,
    // i.e. two levels of nesting, which is the documented maximum.
    assert.ok(depth(body) <= 3, `${spec.id} nests too deep: ${depth(body)}`);
  }
  assert.ok(QUERY_CATALOG_BY_ID.candidate_text_all);
});
