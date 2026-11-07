/**
 * Derivation layer: everything the pages show is computed here from recorded
 * rows. Nothing in this file calls a model or invents a label.
 */
import { CANDIDATES } from "../../supabase/functions/_shared/candidates.ts";
import { normalizeText, scanCandidate } from "../../supabase/functions/_shared/normalize.ts";
import type { VideoRow } from "../../supabase/functions/_shared/types.ts";
import type { Dataset, FactDef, StanceRow } from "./sources.ts";

export interface Index {
  dataset: Dataset;
  candidateById: Map<string, any>;
  videoById: Map<string, VideoRow>;
  stanceByKey: Map<string, StanceRow>;
  stanceByVideo: Map<string, StanceRow[]>;
  videosByCandidate: Map<string, VideoRow[]>;
  eventById: Map<string, any>;
  topicById: Map<string, any>;
  textByVideo: Map<string, string>;
  normalizedByVideo: Map<string, string>;
}

const DAY = 86_400_000;
const addDays = (date: string, days: number) =>
  new Date(new Date(`${date}T00:00:00Z`).valueOf() + days * DAY).toISOString().slice(0, 10);
const dayOf = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

export function videoText(video: VideoRow): string {
  return [video.caption ?? "", ...(video.on_screen_text ?? []), video.transcript ?? ""].filter(Boolean).join(" \n ");
}

export function buildIndex(dataset: Dataset): Index {
  const candidateById = new Map(dataset.candidates.map((candidate) => [candidate.id, candidate]));
  const videoById = new Map(dataset.videos.map((video) => [video.id, video]));
  const stanceByKey = new Map<string, StanceRow>();
  const stanceByVideo = new Map<string, StanceRow[]>();
  for (const row of dataset.stance) {
    stanceByKey.set(`${row.video_id}|${row.candidate_id}`, row);
    const list = stanceByVideo.get(row.video_id) ?? [];
    list.push(row);
    stanceByVideo.set(row.video_id, list);
  }
  const videosByCandidate = new Map<string, VideoRow[]>();
  const textByVideo = new Map<string, string>();
  const normalizedByVideo = new Map<string, string>();
  for (const video of dataset.videos) {
    const text = videoText(video);
    textByVideo.set(video.id, text);
    normalizedByVideo.set(video.id, normalizeText(text));
    for (const candidate of dataset.candidates) {
      if (scanCandidate(text, candidate).length === 0) continue;
      const list = videosByCandidate.get(candidate.id) ?? [];
      list.push(video);
      videosByCandidate.set(candidate.id, list);
    }
  }
  return {
    dataset,
    candidateById,
    videoById,
    stanceByKey,
    stanceByVideo,
    videosByCandidate,
    eventById: new Map(dataset.events.events.map((event) => [event.id, event])),
    topicById: new Map(dataset.events.topics.map((topic) => [topic.id, topic])),
    textByVideo,
    normalizedByVideo,
  };
}

const mentionsCandidate = (index: Index, video: VideoRow, candidateId: string): boolean => {
  const candidate = index.candidateById.get(candidateId);
  return candidate ? scanCandidate(index.textByVideo.get(video.id) ?? "", candidate).length > 0 : false;
};

export function stanceOf(index: Index, videoId: string, candidateId: string): StanceRow | undefined {
  return index.stanceByKey.get(`${videoId}|${candidateId}`);
}

// ── Events page: 7 days before vs after ───────────────────────────────────
export function eventImpact(index: Index, eventId: string, windowDays = 7) {
  const event = index.eventById.get(eventId);
  if (!event) return [];
  const start = dayOf(event.commencement)!;
  const beforeFrom = addDays(start, -windowDays);
  const beforeTo = addDays(start, -1);
  const afterFrom = addDays(start, 1);
  const afterTo = addDays(start, windowDays);

  const candidateIds = new Set<string>();
  for (const id of event.video_ids as string[]) {
    for (const candidate of index.dataset.candidates) {
      const video = index.videoById.get(id);
      if (video && mentionsCandidate(index, video, candidate.id)) candidateIds.add(candidate.id);
    }
  }

  const rows = [];
  for (const candidateId of candidateIds) {
    const videos = index.videosByCandidate.get(candidateId) ?? [];
    const before = videos.filter((video) => {
      const day = dayOf(video.posted_at)!;
      return day >= beforeFrom && day <= beforeTo;
    });
    const after = videos.filter((video) => {
      const day = dayOf(video.posted_at)!;
      return day >= afterFrom && day <= afterTo;
    });
    const leaning = { favorable: 0, critical: 0, neutral: 0, unclear: 0 } as Record<string, number>;
    for (const video of after) {
      const row = stanceOf(index, video.id, candidateId);
      leaning[row?.label ?? "unclear"]++;
    }
    rows.push({
      candidateId,
      candidate: index.candidateById.get(candidateId),
      before: before.length,
      after: after.length,
      changePct: before.length === 0 ? null : Number((((after.length - before.length) / before.length) * 100).toFixed(1)),
      favorableAfter: leaning.favorable,
      criticalAfter: leaning.critical,
      neutralAfter: leaning.neutral,
      unclearAfter: leaning.unclear,
    });
  }
  return rows.sort((a, b) => b.after - a.after);
}

// ── Facts page: one fact → stories → verdicts ─────────────────────────────
const matchesTerm = (normalized: string, term: string): boolean => {
  const needle = normalizeText(term).trim();
  if (!needle) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(normalized);
};

export function factVideos(index: Index, fact: FactDef): VideoRow[] {
  const fromAnchors = index.dataset.videos.filter((video) =>
    fact.anchorTerms.some((term) => matchesTerm(index.normalizedByVideo.get(video.id) ?? "", term)),
  );
  const fromEvents = new Set<string>();
  for (const eventId of fact.eventIds) {
    const event = index.eventById.get(eventId);
    for (const id of event?.video_ids ?? []) fromEvents.add(id);
  }
  const byId = new Map<string, VideoRow>();
  for (const video of fromAnchors) byId.set(video.id, video);
  for (const id of fromEvents) {
    const video = index.videoById.get(id);
    if (video) byId.set(video.id, video);
  }
  return [...byId.values()].sort((a, b) => (a.posted_at ?? "") < (b.posted_at ?? "") ? -1 : 1);
}

export function buildFact(index: Index, fact: FactDef) {
  const videos = factVideos(index, fact);
  const creators = new Set(videos.map((video) => video.creator_handle)).size;

  const storyCounts = new Map<string, { videos: number; favorable: number; critical: number; neutral: number; unclear: number; ids: string[] }>();
  const targeted = new Map<string, { favorable: number; critical: number; neutral: number; unclear: number }>();

  for (const video of videos) {
    const rows = index.stanceByVideo.get(video.id) ?? [];
    const primary = [...rows].sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0];
    const story = primary?.label === "favorable" ? "Seen as a positive"
      : primary?.label === "critical" ? "Seen as a failure"
        : "Reported without a verdict";
    const bucket = storyCounts.get(story) ?? { videos: 0, favorable: 0, critical: 0, neutral: 0, unclear: 0, ids: [] };
    bucket.videos++;
    bucket.ids.push(video.id);
    bucket[(primary?.label ?? "unclear") as "favorable" | "critical" | "neutral" | "unclear"]++;
    storyCounts.set(story, bucket);

    for (const row of rows) {
      const target = targeted.get(row.candidate_id) ?? { favorable: 0, critical: 0, neutral: 0, unclear: 0 };
      target[row.label]++;
      targeted.set(row.candidate_id, target);
    }
  }

  const daily = new Map<string, { videos: number; candidates: Set<string> }>();
  for (const video of videos) {
    const day = dayOf(video.posted_at);
    if (!day) continue;
    const bucket = daily.get(day) ?? { videos: 0, candidates: new Set<string>() };
    bucket.videos++;
    for (const candidate of index.dataset.candidates) {
      if (mentionsCandidate(index, video, candidate.id)) bucket.candidates.add(candidate.id);
    }
    daily.set(day, bucket);
  }

  return {
    fact,
    videos,
    creators,
    stories: [...storyCounts.entries()]
      .map(([label, bucket]) => ({
        label,
        videos: bucket.videos,
        favorable: bucket.favorable,
        critical: bucket.critical,
        neutral: bucket.neutral,
        unclear: bucket.unclear,
        ids: bucket.ids,
      }))
      .sort((a, b) => b.videos - a.videos),
    aimedAt: [...targeted.entries()]
      .map(([candidateId, counts]) => {
        const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        return { candidateId, candidate: index.candidateById.get(candidateId), leaning: entries[0][0], videos: entries.reduce((sum, [, n]) => sum + n, 0), counts };
      })
      .sort((a, b) => b.videos - a.videos),
    timeline: [...daily.entries()]
      .map(([date, bucket]) => ({ date, videos: bucket.videos, candidates: [...bucket.candidates] }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    events: fact.eventIds.map((id) => index.eventById.get(id)).filter(Boolean),
  };
}

// ── Search: lexical by default, embedding cosine when asked ───────────────
export function lexicalSearch(index: Index, query: string, limit = 20) {
  const tokens = normalizeText(query).split(/\s+/).filter((token) => token.length > 2);
  if (tokens.length === 0) return [];
  const df = new Map<string, number>();
  for (const video of index.dataset.videos) {
    const normalized = index.normalizedByVideo.get(video.id) ?? "";
    for (const token of new Set(tokens.filter((t) => normalized.includes(t)))) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const total = index.dataset.videos.length;
  return index.dataset.videos
    .map((video) => {
      const normalized = index.normalizedByVideo.get(video.id) ?? "";
      let score = 0;
      for (const token of tokens) {
        if (!normalized.includes(token)) continue;
        const idf = Math.log((total + 1) / ((df.get(token) ?? 0) + 1)) + 1;
        score += idf * (normalized.split(token).length - 1);
      }
      return { video, score: Number(score.toFixed(3)) };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    dot += a[index] * b[index];
    na += a[index] * a[index];
    nb += b[index] * b[index];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

// ── Creator aggregation ───────────────────────────────────────────────────
export function creatorStance(index: Index, handle: string, minVideos = 2) {
  const rows = index.dataset.stance.filter((row) => row.creator_handle === handle);
  const byCandidate = new Map<string, StanceRow[]>();
  for (const row of rows) {
    const list = byCandidate.get(row.candidate_id) ?? [];
    list.push(row);
    byCandidate.set(row.candidate_id, list);
  }
  return [...byCandidate.entries()]
    .filter(([, list]) => list.length >= minVideos)
    .map(([candidateId, list]) => {
      const counts = { favorable: 0, critical: 0, neutral: 0, unclear: 0 } as Record<string, number>;
      let views = 0;
      let weighted = 0;
      for (const row of list) {
        counts[row.label]++;
        const video = index.videoById.get(row.video_id);
        const weight = video?.views ?? 0;
        views += weight;
        weighted += weight * row.score;
      }
      const videos = list.length;
      return {
        candidateId,
        candidate: index.candidateById.get(candidateId),
        videos,
        ...counts,
        stanceIndex: Number(((counts.favorable - counts.critical) / videos).toFixed(3)),
        viewWeightedIndex: Number((views ? weighted / views : 0).toFixed(3)),
        label: (counts.favorable - counts.critical) / videos >= 0.5 ? "favorable"
          : (counts.favorable - counts.critical) / videos <= -0.5 ? "critical" : "mixed",
        evidence: list.slice(0, 3).map((row) => ({
          videoId: row.video_id,
          quote: row.quote,
          source: row.basis,
          mode: row.evidence_mode,
          url: index.videoById.get(row.video_id)?.url ?? "",
          postedAt: index.videoById.get(row.video_id)?.posted_at ?? null,
        })),
      };
    })
    .sort((a, b) => b.videos - a.videos);
}
