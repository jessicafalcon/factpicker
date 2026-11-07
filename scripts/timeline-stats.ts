/**
 * Timeline statistics over the local Oriane snapshot.
 *
 *   npm run timeline
 *
 * Reads data/oriane/<candidate>.json (no API calls) and writes:
 *   data/analyses/timeline-stats.json
 *   data/analyses/timeline-monthly.csv
 *   data/analyses/timeline-weekly.csv
 *   data/analyses/timeline-candidates.csv
 *
 * All calendar buckets are Europe/Paris local time, because "when was this
 * posted" means the French audience's clock, not UTC.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { CANDIDATES_BY_ID } from "../supabase/functions/_shared/candidates.ts";
import type { VideoRow } from "../supabase/functions/_shared/types.ts";
import { loadEnv, table } from "./lib.ts";

loadEnv();
const DIR = "data/oriane";
const TZ = "Europe/Paris";

// ── Paris-local calendar parts ────────────────────────────────────────────
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  weekday: "short",
});

interface Local {
  date: string;   // YYYY-MM-DD
  month: string;  // YYYY-MM
  hour: number;   // 0-23
  weekday: string;
}

function toLocal(iso: string): Local {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(iso))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    month: `${parts.year}-${parts.month}`,
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    weekday: parts.weekday,
  };
}

/** ISO week label (YYYY-Www) from the Paris date. */
function isoWeek(date: string): string {
  const day = new Date(`${date}T12:00:00Z`);
  const target = new Date(day.valueOf());
  const dayNumber = (day.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target.valueOf() - firstThursday.valueOf()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(`${b}T00:00:00Z`).valueOf() - new Date(`${a}T00:00:00Z`).valueOf()) / 86_400_000);

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const mean = (values: number[]) =>
  values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;

// ── Load ──────────────────────────────────────────────────────────────────
const files = readdirSync(DIR).filter(
  (file) => file.endsWith(".json") && !file.startsWith("_") && file !== "top10-all.json",
);

interface CandidateVideo {
  candidateId: string;
  video: VideoRow;
  ownMention: boolean;
}

const videosById = new Map<string, VideoRow>();
const perCandidate = new Map<string, CandidateVideo[]>();

for (const file of files) {
  const payload = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8"));
  const candidateId: string = payload.candidate.id;
  if (!CANDIDATES_BY_ID[candidateId]) continue;

  const ownVideos = new Set(
    payload.mentions
      .filter((mention: any) => mention.candidate_id === candidateId)
      .map((mention: any) => mention.video_id),
  );
  const rows: CandidateVideo[] = [];

  for (const video of payload.videos as VideoRow[]) {
    if (!video.posted_at) continue;
    videosById.set(video.id, video);
    if (video.is_french) {
      rows.push({ candidateId, video, ownMention: ownVideos.has(video.id) });
    }
  }
  perCandidate.set(candidateId, rows);
}

// Stance labels keyed by video, from the candidate it was scored against.
const stanceByVideo = new Map<string, string>();
const stancePath = "data/analyses/candidate-stance.json";
if (existsSync(stancePath)) {
  const stance = JSON.parse(readFileSync(stancePath, "utf8"));
  for (const row of stance.videos ?? []) {
    if (!stanceByVideo.has(row.video_id) && row.label !== "unclear") {
      stanceByVideo.set(row.video_id, row.label);
    }
  }
}

const videos = [...videosById.values()].sort((a, b) => (a.posted_at! < b.posted_at! ? -1 : 1));
const french = videos.filter((video) => video.is_french);

const dated = videos.map((video) => ({ video, local: toLocal(video.posted_at!) }));
const first = dated[0];
const last = dated[dated.length - 1];
const spanDays = daysBetween(first.local.date, last.local.date);

// ── Buckets ───────────────────────────────────────────────────────────────
function bucket(keyOf: (entry: (typeof dated)[number]) => string) {
  const map = new Map<string, typeof dated>();
  for (const entry of dated) {
    const key = keyOf(entry);
    const list = map.get(key) ?? [];
    list.push(entry);
    map.set(key, list);
  }
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

function summarise(key: string, entries: typeof dated) {
  const views = entries.map((entry) => entry.video.views).filter((value): value is number => value !== null);
  const interactions = entries
    .map((entry) => entry.video.interactions)
    .filter((value): value is number => value !== null);
  const labels = entries
    .map((entry) => stanceByVideo.get(entry.video.id))
    .filter((value): value is string => Boolean(value));

  return {
    bucket: key,
    videos: entries.length,
    french: entries.filter((entry) => entry.video.is_french).length,
    creators: new Set(entries.map((entry) => entry.video.creator_handle)).size,
    total_views: views.reduce((sum, value) => sum + value, 0),
    avg_views: mean(views),
    median_views: median(views),
    total_interactions: interactions.reduce((sum, value) => sum + value, 0),
    talking: entries.filter((entry) => entry.video.format === "talking").length,
    image_post: entries.filter((entry) => entry.video.format === "image_post").length,
    instagram: entries.filter((entry) => entry.video.platform === "instagram").length,
    tiktok: entries.filter((entry) => entry.video.platform === "tiktok").length,
    youtube: entries.filter((entry) => entry.video.platform === "youtube").length,
    favorable: labels.filter((label) => label === "favorable").length,
    critical: labels.filter((label) => label === "critical").length,
    neutral: labels.filter((label) => label === "neutral").length,
    with_decisive_stance: labels.length,
  };
}

const monthly = bucket((entry) => entry.local.month).map(([key, entries]) => summarise(key, entries));
const weekly = bucket((entry) => isoWeek(entry.local.date)).map(([key, entries]) => summarise(key, entries));
const daily = bucket((entry) => entry.local.date).map(([key, entries]) => ({
  date: key,
  videos: entries.length,
  views: entries.reduce((sum, entry) => sum + (entry.video.views ?? 0), 0),
}));

// ── Distributions ─────────────────────────────────────────────────────────
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const byWeekday = WEEKDAYS.map((weekday) => ({
  weekday,
  videos: dated.filter((entry) => entry.local.weekday === weekday).length,
}));

const byHour = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  videos: dated.filter((entry) => entry.local.hour === hour).length,
}));

// ── Gaps and bursts ───────────────────────────────────────────────────────
const gaps = dated.slice(1).map((entry, index) => ({
  from: dated[index].local.date,
  to: entry.local.date,
  days: daysBetween(dated[index].local.date, entry.local.date),
}));
const largestGaps = [...gaps].sort((a, b) => b.days - a.days).slice(0, 5);
const busiestDays = [...daily].sort((a, b) => b.videos - a.videos || b.views - a.views).slice(0, 5);
const silentDays = spanDays + 1 - daily.length;

// ── Per candidate ─────────────────────────────────────────────────────────
const candidateRows = [...perCandidate.entries()]
  .filter(([, rows]) => rows.length > 0)
  .map(([candidateId, rows]) => {
    const sorted = [...rows].sort((a, b) => (a.video.posted_at! < b.video.posted_at! ? -1 : 1));
    const dates = sorted.map((row) => toLocal(row.video.posted_at!));
    const views = sorted.map((row) => row.video.views).filter((value): value is number => value !== null);
    const byMonth = dates.reduce<Record<string, number>>((acc, local) => {
      acc[local.month] = (acc[local.month] ?? 0) + 1;
      return acc;
    }, {});
    const candidate = CANDIDATES_BY_ID[candidateId];
    return {
      candidate_id: candidateId,
      name: candidate.name,
      tier: candidate.tier,
      videos: rows.length,
      first_posted: sorted[0].video.posted_at,
      last_posted: sorted[sorted.length - 1].video.posted_at,
      span_days: daysBetween(dates[0].date, dates[dates.length - 1].date),
      median_date: dates[Math.floor(dates.length / 2)].date,
      with_own_mention: rows.filter((row) => row.ownMention).length,
      total_views: views.reduce((sum, value) => sum + value, 0),
      avg_views: mean(views),
      creators: new Set(rows.map((row) => row.video.creator_handle)).size,
      by_month: byMonth,
    };
  })
  .sort((a, b) => (a.first_posted! < b.first_posted! ? -1 : 1));

// ── Overall ───────────────────────────────────────────────────────────────
const allViews = french.map((video) => video.views).filter((value): value is number => value !== null);
const activeDays = daily.length;

const result = {
  generatedAt: new Date().toISOString(),
  timezone: TZ,
  source: `${files.length} candidate files in ${DIR}`,
  range: {
    first_posted: first.video.posted_at,
    last_posted: last.video.posted_at,
    first_date: first.local.date,
    last_date: last.local.date,
    span_days: spanDays,
    span_weeks: Number((spanDays / 7).toFixed(1)),
  },
  totals: {
    unique_videos: videos.length,
    french_videos: french.length,
    non_french_videos: videos.length - french.length,
    creators: new Set(french.map((video) => video.creator_handle)).size,
    candidates: candidateRows.length,
    active_days: activeDays,
    silent_days: silentDays,
    videos_per_active_day: Number((french.length / activeDays).toFixed(2)),
    videos_per_week: Number((french.length / (spanDays / 7)).toFixed(2)),
    with_stance_label: french.filter((video) => stanceByVideo.has(video.id)).length,
    total_views: allViews.reduce((sum, value) => sum + value, 0),
    avg_views: mean(allViews),
    median_views: median(allViews),
  },
  monthly,
  weekly,
  daily,
  by_weekday: byWeekday,
  by_hour: byHour,
  largest_gaps: largestGaps,
  busiest_days: busiestDays,
  candidates: candidateRows,
};

// ── Write ─────────────────────────────────────────────────────────────────
mkdirSync("data/analyses", { recursive: true });
writeFileSync("data/analyses/timeline-stats.json", JSON.stringify(result, null, 2));

const csvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
const toCsv = (rows: Array<Record<string, unknown>>) => {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n");
};

writeFileSync("data/analyses/timeline-monthly.csv", toCsv(monthly));
writeFileSync("data/analyses/timeline-weekly.csv", toCsv(weekly));
writeFileSync("data/analyses/timeline-candidates.csv", toCsv(candidateRows));

// ── Report ────────────────────────────────────────────────────────────────
console.log(
  `Timeline: ${first.local.date} → ${last.local.date} (${spanDays} days, ${activeDays} active days, ${silentDays} silent)`,
);
console.log(`Videos: ${videos.length} (${french.length} French) | creators: ${result.totals.creators} | candidates: ${candidateRows.length}`);

console.log("\nMonthly:");
console.log(
  table(
    monthly.map((row) => ({
      month: row.bucket,
      videos: row.videos,
      creators: row.creators,
      views: row.total_views,
      avg_views: row.avg_views,
      talking: row.talking,
      image: row.image_post,
      fav: row.favorable,
      crit: row.critical,
      neu: row.neutral,
    })),
  ),
);

console.log("\nWeekly (most recent 10):");
console.log(
  table(
    weekly.slice(-10).map((row) => ({
      week: row.bucket,
      videos: row.videos,
      views: row.total_views,
      fav: row.favorable,
      crit: row.critical,
    })),
  ),
);

console.log("\nWeekday:");
console.log(table(byWeekday));

console.log("\nTop posting hours (Paris):");
console.log(table([...byHour].sort((a, b) => b.videos - a.videos).slice(0, 6)));

console.log("\nLargest gaps:");
console.log(table(largestGaps));

console.log("\nBusiest days:");
console.log(table(busiestDays));

console.log("\nCandidate timelines:");
console.log(
  table(
    candidateRows.slice(0, 12).map((row) => ({
      candidate: row.candidate_id,
      videos: row.videos,
      first: row.first_posted?.slice(0, 10),
      last: row.last_posted?.slice(0, 10),
      span: row.span_days,
      creators: row.creators,
    })),
  ),
);

console.log("\nWrote data/analyses/timeline-stats.json + timeline-{monthly,weekly,candidates}.csv");
