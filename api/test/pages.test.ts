import test from "node:test";
import assert from "node:assert/strict";
import { loadFromArtifacts } from "../src/sources.ts";
import { createContext } from "../src/context.ts";
import { buildEventInsight, buildFactReadings } from "../src/derive.ts";
import { execute } from "../src/app.ts";

const dataset = loadFromArtifacts();
const ctx = createContext(dataset, { available: false, embed: async () => [] } as any);

test("event insight: daily rates compare a 14-day baseline with 72 hours", () => {
  const insight = buildEventInsight(ctx.index, "protest_17_october", 14, 72)!;
  assert.equal(insight.beforeDays, 14);
  assert.equal(insight.afterDays, 3);
  assert.ok(insight.afterVideos > 0);
  assert.ok(insight.impacts.length > 0);
  assert.equal(insight.afterPerDay, Number((insight.afterVideos / 3).toFixed(2)));
  for (const row of insight.impacts) {
    assert.equal(row.beforePerDay, Number((row.before / 14).toFixed(2)));
    assert.equal(row.afterPerDay, Number((row.after / 3).toFixed(2)));
    if (row.beforePerDay > 0) {
      assert.equal(row.multiplier, Number((row.afterPerDay / row.beforePerDay).toFixed(2)));
    } else {
      assert.equal(row.multiplier, null);
    }
  }
  assert.ok(insight.facts.every((item) => item.videos > 0));
  assert.ok(insight.facts.length <= 4);
});

test("event insight: biggest rises are the largest favourable / critical increases", () => {
  const insight = buildEventInsight(ctx.index, "protest_17_october", 14, 72)!;
  const rises = (key: "favorable" | "critical") =>
    insight.impacts
      .map((row) => row[`${key}AfterPerDay`] - row[`${key}BeforePerDay`])
      .sort((a, b) => b - a);
  for (const key of ["favorable", "critical"] as const) {
    const pick = insight[`biggest${key === "favorable" ? "Favorable" : "Critical"}`]!;
    if (!pick) continue;
    assert.equal(pick[`${key}AfterPerDay`] - pick[`${key}BeforePerDay`], rises(key)[0]);
  }
});

test("fact readings: grouped, dominant leaning, two representatives", () => {
  const fact = dataset.facts.find((item) => item.id === "pension_2023_64")!;
  const readings = buildFactReadings(ctx.index, fact);
  assert.ok(readings.length >= 2);
  const total = readings.reduce((sum, reading) => sum + reading.videos, 0);
  assert.ok(total <= 40);
  for (const reading of readings) {
    assert.equal(reading.favorable + reading.critical + reading.neutral, reading.videos);
    const max = Math.max(reading.favorable, reading.critical, reading.neutral);
    const dominant =
      reading.favorable >= reading.critical && reading.favorable >= reading.neutral
        ? "favorable"
        : reading.critical >= reading.neutral
          ? "critical"
          : "neutral";
    assert.equal(max, reading[dominant]);
    assert.ok(reading.representativeIds.length <= 2);
  }
});

test("graphql: eventInsight and fact readings expose the page-2/3 shape", async () => {
  const result = await execute({
    source: `{ eventInsight(id: "protest_17_october") { afterDays multiplier impacts { candidate { name } afterPerDay multiplier } biggestFavorable { candidate { name } favorableAfterPerDay } facts { label videos } }
               fact(id: "pension_2023_64") { readings { label videos dominant representatives { composed } } } }`,
    context: ctx,
  });
  assert.equal(result.errors, undefined);
  const insight: any = result.data!.eventInsight;
  assert.equal(insight.afterDays, 3);
  assert.ok(insight.impacts.length > 0);
  const readings: any[] = result.data!.fact.readings;
  assert.ok(readings.length > 0);
  assert.ok(["FAVORABLE", "CRITICAL", "NEUTRAL"].includes(readings[0].dominant));
});
