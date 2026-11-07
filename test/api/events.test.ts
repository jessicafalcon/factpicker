import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { CANDIDATES_BY_ID } from "../../supabase/functions/_shared/candidates.ts";

const PATH = "data/analyses/events.json";
const CSV = "data/analyses/events.csv";
const skip = existsSync(PATH) ? false : "run `npm run events` first";
const load = () => JSON.parse(readFileSync(PATH, "utf8"));
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).valueOf();

test("events artifact covers the dataset window", { skip }, () => {
  const data = load();
  assert.equal(data.window.first, "2026-08-08");
  assert.equal(data.window.last, "2026-11-02");
  assert.ok(data.events.length >= 10, "expected at least 10 events");
  assert.ok(data.scandals.length >= 3, "expected at least 3 scandals");
  assert.ok(data.topics.length >= 10, "expected at least 10 topics");
  assert.equal(data.summary.events, data.events.length);
  assert.equal(data.summary.scandals, data.scandals.length);
});

test("events are ordered by commencement and dated inside the window", { skip }, () => {
  const data = load();
  const starts = data.events.map((event: any) => event.commencement);
  assert.deepEqual(starts, [...starts].sort());
  for (const event of data.events) {
    assert.ok(event.commencement >= data.window.first, `${event.id} starts before the window`);
    assert.ok(event.last_covered_at.slice(0, 10) <= data.window.last, `${event.id} ends after the window`);
    assert.ok(event.commencement <= event.last_covered_at.slice(0, 10));
    assert.equal(event.commencement_basis, "first_covered_video");
  }
});

test("every event timeline reconciles with its video count", { skip }, () => {
  const data = load();
  for (const event of data.events) {
    const summed = event.timeline.reduce((total: number, bucket: any) => total + bucket.videos, 0);
    assert.equal(summed, event.videos, `${event.id} timeline sums to ${summed}, expected ${event.videos}`);
    assert.equal(event.active_days, event.timeline.length);
    assert.equal(event.video_ids.length, event.videos);
    assert.equal(new Set(event.video_ids).size, event.videos, `${event.id} has duplicate video ids`);
    // Peak must be a real bucket and the largest one.
    const peak = [...event.timeline].sort((a: any, b: any) => b.videos - a.videos)[0];
    assert.equal(event.peak_videos, peak.videos);
    assert.equal(event.peak_date, peak.date);
    // Duration matches first/last.
    const span = Math.round((day(event.last_covered_at) - day(event.commencement)) / 86_400_000);
    assert.equal(event.duration_days, span);
    // Timeline is sorted and unique per day.
    const dates = event.timeline.map((bucket: any) => bucket.date);
    assert.deepEqual(dates, [...dates].sort());
    assert.equal(new Set(dates).size, dates.length);
  }
});

test("event evidence is drawn from the event's own videos", { skip }, () => {
  const data = load();
  for (const event of data.events) {
    const ids = new Set(event.video_ids);
    assert.ok(event.evidence.length > 0, `${event.id} has no evidence`);
    for (const item of event.evidence) {
      assert.ok(ids.has(item.video_id), `${event.id} cites a foreign video ${item.video_id}`);
      assert.ok(item.quote && item.quote.length > 0, `${event.id} evidence without a quote`);
      assert.ok(item.matched_anchors.length > 0, `${event.id} evidence without an anchor`);
      assert.ok(item.url.startsWith("http"), `${event.id} evidence without a url`);
    }
  }
});

test("event metadata uses known kinds, categories and candidates", { skip }, () => {
  const data = load();
  const kinds = new Set(["scandal", "policy", "campaign", "society", "international"]);
  for (const event of data.events) {
    assert.ok(kinds.has(event.kind), `${event.id} has unknown kind ${event.kind}`);
    assert.ok(["high", "medium", "low"].includes(event.confidence));
    assert.equal(event.is_scandal, event.kind === "scandal");
    for (const candidate of event.candidates) {
      assert.ok(CANDIDATES_BY_ID[candidate.id], `${event.id} references unknown candidate ${candidate.id}`);
      assert.ok(candidate.videos > 0 && candidate.videos <= event.videos);
    }
    for (const date of event.dates_mentioned_explicit) {
      assert.ok(date.startsWith("2026"), `${event.id} keeps a non-campaign date ${date}`);
    }
    assert.ok(event.evidence.length <= 4, "evidence is capped at 4 items");
  }
});

test("topics reconcile and the scandal subset is consistent", { skip }, () => {
  const data = load();
  for (const topic of data.topics) {
    const summed = topic.timeline.reduce((total: number, bucket: any) => total + bucket.videos, 0);
    assert.equal(summed, topic.videos, `topic ${topic.id} timeline mismatch`);
    assert.ok(topic.first_covered_at <= topic.last_covered_at);
    assert.equal(topic.active_days, topic.timeline.length);
    assert.ok(topic.videos <= 209);
  }
  const scandalIds = new Set(data.scandals.map((event: any) => event.id));
  for (const event of data.events) {
    if (event.is_scandal) assert.ok(scandalIds.has(event.id), `${event.id} missing from scandals`);
  }
  // Union of event videos is what the summary claims.
  const union = new Set(data.events.flatMap((event: any) => event.video_ids));
  assert.equal(data.summary.videosCoveredByAnEvent, union.size);
});

test("the long-format CSV has one row per event × active day", { skip }, () => {
  const data = load();
  const rows = readFileSync(CSV, "utf8").trim().split("\n");
  const expected = 1 + data.events.reduce((total: number, event: any) => total + event.timeline.length, 0);
  assert.equal(rows.length, expected);
  assert.equal(rows[0], "event_id,title,category,kind,is_scandal,date,videos,candidates");
  for (const row of rows.slice(1)) {
    assert.equal(row.split('","').length, 8, `malformed row: ${row.slice(0, 60)}`);
  }
});

test("the 17 October mobilisation is separated from the 1961 massacre", { skip }, () => {
  const data = load();
  const protest = data.events.find((event: any) => event.id === "protest_17_october");
  const massacre = data.events.find((event: any) => event.id === "paris_massacre_1961");
  assert.ok(protest, "the 2026 mobilisation must be present");
  assert.ok(massacre, "the 1961 memory thread must be present");
  assert.ok(protest.videos >= 4);
  assert.notEqual(protest.commencement, massacre.commencement);
  // Disambiguation: no 1961 video may leak into the 2026 event.
  const overlap = new Set(protest.video_ids).intersection(new Set(massacre.video_ids));
  assert.equal(overlap.size, 0, "1961 coverage leaked into the 2026 protest");
});

test("every event sits in exactly one major/sub issue bucket", { skip }, () => {
  const data = load();
  const placed = new Map<string, number>();
  for (const group of data.issue_groups) {
    assert.ok(group.major_issue && group.videos >= 0);
    assert.ok(group.sub_issues.length > 0);
    for (const sub of group.sub_issues) {
      assert.ok(Array.isArray(sub.topics) && Array.isArray(sub.events));
      for (const event of sub.events) {
        placed.set(event.id, (placed.get(event.id) ?? 0) + 1);
      }
    }
  }
  assert.equal(placed.size, data.events.length, "an event is missing from the hierarchy");
  for (const [id, times] of placed) assert.equal(times, 1, `${id} is placed ${times} times`);
  for (const event of data.events) {
    assert.ok(placed.has(event.id), `${event.id} not in any issue group`);
    assert.ok(event.major_issue && event.sub_issue);
  }
});

test("candidate × topic matrix reconciles with its leaning counts", { skip }, () => {
  const data = load();
  assert.ok(data.candidate_topic_matrix.length >= 20);
  for (const row of data.candidate_topic_matrix) {
    assert.ok(CANDIDATES_BY_ID[row.candidate_id], `unknown candidate ${row.candidate_id}`);
    for (const topic of row.topics) {
      assert.equal(
        topic.favorable + topic.critical + topic.neutral + topic.unclear,
        topic.videos,
        `${row.candidate_id}/${topic.topic} leaning does not sum to videos`,
      );
      assert.ok(topic.videos <= 209);
      const expected = Number(((topic.favorable - topic.critical) / topic.videos).toFixed(3));
      assert.equal(topic.index, expected, `${row.candidate_id}/${topic.topic} index mismatch`);
    }
    const total = row.topics.reduce((sum: number, topic: any) => sum + topic.videos, 0);
    assert.equal(row.videos, total);
  }
});
