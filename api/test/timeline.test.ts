import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, execute } from "../src/app.ts";
import { createEmbeddingClient, loadFromArtifacts } from "../src/sources.ts";
import { buildIndex, buildFactTimeline } from "../src/derive.ts";

const dataset = loadFromArtifacts();
const index = buildIndex(dataset);
const ctx = createContext(dataset, createEmbeddingClient({}));
const run = (source: string, variableValues?: Record<string, unknown>) => execute({ source, variableValues, context: ctx });
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

test("timeline: one node per day, chronological, inside the dataset window", () => {
  for (const fact of dataset.facts) {
    const timeline = buildFactTimeline(index, fact, 3);
    assert.ok(timeline.moments.length <= 8, `${fact.id}: more than 8 moments`);
    const dates = timeline.moments.map((moment: any) => moment.date);
    assert.deepEqual(dates, [...dates].sort(), `${fact.id}: moments are not chronological`);
    assert.equal(new Set(dates).size, dates.length, `${fact.id}: duplicate dates`);
    for (const date of dates) {
      assert.ok(date >= dataset.events.window.first && date <= dataset.events.window.last, `${fact.id}: ${date} outside window`);
    }
    const months = timeline.moments.map((moment: any) => moment.month);
    assert.deepEqual(timeline.months, [...new Set(months)], `${fact.id}: months do not match the moments`);
  }
});

test("timeline: the video count equals the corpus count in that window", () => {
  for (const fact of dataset.facts) {
    const timeline = buildFactTimeline(index, fact, 3);
    for (const moment of timeline.moments as any[]) {
      assert.equal(days(moment.windowStart, moment.windowEnd), 3, `${fact.id}/${moment.id}: window is not 3 days`);
      const actual = dataset.videos.filter(
        (video) => video.posted_at && video.posted_at.slice(0, 10) >= moment.windowStart && video.posted_at.slice(0, 10) <= moment.windowEnd,
      ).length;
      assert.equal(moment.totalVideos, actual, `${fact.id}/${moment.id}: total count`);
      const highlighted = moment.facts.find((chip: any) => chip.highlighted);
      assert.equal(moment.videos, highlighted.videos, `${fact.id}/${moment.id}: citations != highlighted chip`);
      assert.ok(moment.videos > 0, `${fact.id}/${moment.id}: moment kept with no citation`);
    }
  }
});

test("timeline: chips are ordered, exactly one is highlighted, and the split matches it", () => {
  for (const fact of dataset.facts) {
    const timeline = buildFactTimeline(index, fact, 3);
    for (const moment of timeline.moments as any[]) {
      const highlighted = moment.facts.filter((chip: any) => chip.highlighted);
      assert.ok(highlighted.length <= 1, `${fact.id}/${moment.id}: more than one highlighted chip`);
      const counts = moment.facts.map((chip: any) => chip.videos);
      assert.deepEqual(counts, [...counts].sort((a: number, b: number) => b - a), `${fact.id}/${moment.id}: chips not ordered`);
      assert.ok(moment.facts.length <= 4, `${fact.id}/${moment.id}: too many chips`);
      assert.ok(moment.facts.every((chip: any) => chip.videos > 0), `${fact.id}/${moment.id}: zero-count chip rendered`);
      const split = moment.verdicts;
      const factVideos = highlighted[0]?.videos ?? 0;
      if (highlighted.length) assert.equal(highlighted[0].id, fact.id);
      assert.equal(split.forCandidate + split.againstCandidate + split.noSide, factVideos, `${fact.id}/${moment.id}: split does not match the fact count`);
      assert.equal(moment.hasSelectedFact, factVideos > 0);
    }
  }
});

test("timeline: a fact's own appearances are never crowded out", () => {
  for (const fact of dataset.facts) {
    const timeline = buildFactTimeline(index, fact, 3);
    const appearances = timeline.moments.filter((moment: any) => moment.hasSelectedFact).length;
    const withPresence = dataset.facts.length > 0 ? appearances : 0;
    if (withPresence <= 8) {
      // Every moment where the fact appears must survive the 8-node cut.
      const reproduced = dataset.facts && buildFactTimeline(index, fact, 3).moments.filter((m: any) => m.hasSelectedFact).length;
      assert.equal(reproduced, withPresence);
    }
    // Positive control: the education fact appears during the 17 October protest.
    if (fact.id === "education_budget_2027") {
      const protest = timeline.moments.find((moment: any) => moment.date === "2026-10-17");
      assert.ok(protest, "education: missing the 17 October moment");
      assert.ok(protest.facts.find((chip: any) => chip.highlighted).videos >= 1);
    }
  }
});

test("timeline: each fact has its own moments and its own counts", () => {
  const build = (id: string) => {
    const fact = dataset.facts.find((item) => item.id === id)!;
    return buildFactTimeline(index, fact, 3);
  };
  const cost = build("cost_of_living");
  const education = build("education_budget_2027");
  assert.ok(cost.moments.length > education.moments.length, "cost of living should span more moments than education");
  assert.notDeepEqual(cost.moments.map((m: any) => m.date), education.moments.map((m: any) => m.date));
  assert.ok(education.moments.every((m: any) => m.date >= "2026-10-01"), "education should be October-only");
  const totals = new Set([cost.videosInBursts, education.videosInBursts]);
  assert.equal(totals.size, 2, "citation totals should differ per fact");
});

test("timeline: deterministic and null-safe", async () => {
  const fact = dataset.facts.find((item) => item.id === "pension_2023_64")!;
  assert.deepEqual(buildFactTimeline(index, fact, 3), buildFactTimeline(index, fact, 3));

  const missing = await run(`{ factTimeline(factId: "does_not_exist") { factId } }`);
  assert.deepEqual(missing.errors, undefined);
  assert.equal(missing.data.factTimeline, null);
});

test("graphql: factTimelines returns one timeline per fact with the client shape", async () => {
  const result = await run(`{
    factTimelines {
      factId windowDays months videosInBursts totalVideosInBursts
      fact { id category statement videos }
      moments {
        id date month kind label title windowStart windowEnd videos totalVideos hasSelectedFact
        facts { id label videos highlighted }
        verdicts { forCandidate againstCandidate noSide }
      }
    }
  }`);
  assert.deepEqual(result.errors, undefined);
  assert.equal(result.data.factTimelines.length, dataset.facts.length);
  const pension = result.data.factTimelines.find((timeline: any) => timeline.factId === "pension_2023_64");
  assert.ok(pension.moments.length >= 4, "pension: expected several moments");
  assert.equal(pension.windowDays, 3);
  assert.ok(pension.moments.some((moment: any) => moment.facts.some((chip: any) => chip.highlighted)), "pension: no moment highlights the fact");
  for (const moment of pension.moments) {
    assert.equal(typeof moment.verdicts.againstCandidate, "number");
    assert.ok(moment.facts.every((chip: any) => chip.videos > 0));
    for (const chip of moment.facts.filter((item: any) => item.highlighted)) assert.equal(chip.id, "pension_2023_64");
  }
});
