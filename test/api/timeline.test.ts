/**
 * Invariants for data/analyses/timeline-stats.json.
 * Offline: reads the snapshot and the computed stats only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const PATH = "data/analyses/timeline-stats.json";
const skip = existsSync(PATH) ? false : "run `npm run timeline` first";
const load = () => JSON.parse(readFileSync(PATH, "utf8"));

test("timeline covers the snapshot range", { skip }, () => {
  const data = load();
  assert.equal(data.timezone, "Europe/Paris");
  assert.ok(data.range.first_date < data.range.last_date);
  assert.equal(
    data.range.span_days,
    Math.round(
      (new Date(`${data.range.last_date}T00:00:00Z`).valueOf() -
        new Date(`${data.range.first_date}T00:00:00Z`).valueOf()) /
        86_400_000,
    ),
  );
  assert.ok(data.totals.unique_videos > 200);
  assert.equal(data.totals.french_videos + data.totals.non_french_videos, data.totals.unique_videos);
});

test("every bucket sums to the same video count", { skip }, () => {
  const data = load();
  const total = data.totals.unique_videos;
  for (const key of ["monthly", "weekly", "daily"] as const) {
    const sum = data[key].reduce((acc: number, row: any) => acc + row.videos, 0);
    assert.equal(sum, total, `${key} must account for every video`);
  }
  assert.equal(
    data.by_weekday.reduce((acc: number, row: any) => acc + row.videos, 0),
    total,
    "weekday distribution must account for every video",
  );
  assert.equal(
    data.by_hour.reduce((acc: number, row: any) => acc + row.videos, 0),
    total,
    "hour distribution must account for every video",
  );
});

test("calendar buckets are ordered and consistent", { skip }, () => {
  const data = load();
  for (const key of ["monthly", "weekly", "daily"] as const) {
    const buckets = data[key].map((row: any) => row.bucket ?? row.date);
    const sorted = [...buckets].sort();
    assert.deepEqual(buckets, sorted, `${key} buckets must be chronologically ordered`);
    assert.equal(new Set(buckets).size, buckets.length, `${key} has duplicate buckets`);
  }
  for (const row of data.monthly) {
    assert.equal(row.videos, row.talking + row.image_post);
    assert.equal(row.videos, row.instagram + row.tiktok + row.youtube);
    assert.ok(row.with_decisive_stance <= row.videos);
  }
});

test("active and silent days cover the whole span", { skip }, () => {
  const data = load();
  assert.equal(data.totals.active_days, data.daily.length);
  assert.equal(data.totals.active_days + data.totals.silent_days, data.range.span_days + 1);
  assert.ok(data.totals.videos_per_active_day > 0);
});

test("candidate timelines are ordered and plausible", { skip }, () => {
  const data = load();
  assert.ok(data.candidates.length >= 30);
  for (const row of data.candidates) {
    assert.ok(row.first_posted <= row.last_posted, `${row.candidate_id} first/last order`);
    assert.ok(row.span_days >= 0);
    assert.ok(row.videos >= 1);
    assert.ok(row.creators <= row.videos);
    const monthSum = Object.values(row.by_month).reduce((acc: number, value: any) => acc + Number(value), 0);
    assert.equal(monthSum, row.videos, `${row.candidate_id} monthly split`);
  }
});

test("gaps and busiest days agree with the daily series", { skip }, () => {
  const data = load();
  const busiest = data.busiest_days[0];
  const fromDaily = [...data.daily].sort((a: any, b: any) => b.videos - a.videos)[0];
  assert.equal(busiest.videos, fromDaily.videos);
  for (const gap of data.largest_gaps) assert.ok(gap.days >= 1, "a gap is at least one day");
});
