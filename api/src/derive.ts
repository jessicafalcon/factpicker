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
// `addDays` is the single date-shift helper for this module.

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

const factCitations = new WeakMap<Index, Map<string, VideoRow[]>>();

/**
 * The dataset is fixed for a deployment, so derived payloads are computed once
 * per index instead of per request. Edge functions meter CPU per request; six
 * facts plus six timelines plus the anatomy cards cost ~550ms of it.
 */
const derivedCache = new WeakMap<Index, Map<string, unknown>>();
function memo<T>(index: Index, key: string, compute: () => T): T {
  let cache = derivedCache.get(index);
  if (!cache) {
    cache = new Map();
    derivedCache.set(index, cache);
  }
  if (cache.has(key)) return cache.get(key) as T;
  const value = compute();
  cache.set(key, value);
  return value;
}

/**
 * Citations are asked for repeatedly — six facts × six timelines × the Sankey.
 * Compute each fact once per index; without this the same scans run dozens of
 * times per request and the edge function hits its CPU limit.
 */
export function factVideos(index: Index, fact: FactDef): VideoRow[] {
  let byFact = factCitations.get(index);
  if (!byFact) {
    byFact = new Map();
    factCitations.set(index, byFact);
  }
  const cached = byFact.get(fact.id);
  if (cached) return cached;

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
  const result = [...byId.values()].sort((a, b) => (a.posted_at ?? "") < (b.posted_at ?? "") ? -1 : 1);
  byFact.set(fact.id, result);
  return result;
}

function buildFactUncached(index: Index, fact: FactDef) {
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
    sankey: buildSankey(index, fact),
  };
}

// ── "One fact, many readings": readings → verdicts ───────────────────────
/**
 * Reading families. A video's reading is the family with the most distinct
 * term hits in its text; unmatched videos fall into "Other readings". This is a
 * deterministic rules layer, not a model: the label is a claim about the words
 * present, and the videos behind every node are auditable.
 */
export const READING_FAMILIES: Array<{ id: string; label: string; terms: string[] }> = [
  {
    id: "protests",
    label: "Sparked protests",
    terms: ["manifestation", "manifestations", "manif", "greve", "greves", "rue", "colere", "mobilisation", "mobilisations", "revolte", "blocage", "blocus"],
  },
  {
    id: "workers",
    label: "Unfair to manual workers",
    terms: ["injuste", "injustice", "penible", "manuel", "manuels", "ouvrier", "ouvriers", "precarite", "carriere longue", "penibilite"],
  },
  {
    id: "funding",
    label: "About funding the system",
    terms: ["financement", "financee", "financer", "deficit", "cotisation", "cotisations", "equilibre", "sauver", "depense", "budget"],
  },
  {
    id: "forced",
    label: "Forced through Parliament",
    terms: ["49 3", "passe en force", "sans vote", "parlement", "assemblee nationale", "article 49"],
  },
  {
    id: "repeal",
    label: "Should be repealed",
    terms: ["abroger", "abrogation", "annuler", "retirer", "revenir en arriere", "repeal"],
  },
  {
    id: "public_services",
    label: "Public services are being abandoned",
    terms: ["abandonne", "abandonnes", "fermeture", "fermetures", "postes", "professeur", "professeurs", "enseignant", "enseignants", "ecole", "ecoles", "classe", "classes", "hopital", "hopitaux"],
  },
  {
    id: "ruling",
    label: "The ruling disqualifies them",
    terms: ["condamnation", "condamne", "condamnee", "ineligibilite", "bracelet electronique", "proces", "appel", "justice"],
  },
  {
    id: "prices",
    label: "Prices are crushing wages",
    terms: ["prix", "inflation", "smic", "cout de la vie", "loyer", "loyers", "essence", "facture"],
  },
  {
    id: "immigration",
    label: "The law goes too far or not far enough",
    terms: ["oqtf", "regularisation", "sans papiers", "frontiere", "frontieres", "expulsion", "immigration"],
  },
  {
    id: "security",
    label: "A question of security",
    terms: ["insecurite", "delinquance", "police", "securite", "narcotrafic", "terrorisme"],
  },
];

const OTHER_READING = { id: "other", label: "Other readings" };

export type VerdictBucket = "FOR" | "AGAINST" | "NONE";

const bucketOf = (label: string | undefined): VerdictBucket =>
  label === "favorable" ? "FOR" : label === "critical" ? "AGAINST" : "NONE";

export function primaryStance(index: Index, videoId: string) {
  return [...(index.stanceByVideo.get(videoId) ?? [])].sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0];
}

export function buildSankey(index: Index, fact: FactDef) {
  const videos = factVideos(index, fact);
  const viewsOf = (video: VideoRow) => video.views ?? 0;

  const readings = new Map<string, { id: string; label: string; videos: number; views: number; buckets: Record<VerdictBucket, { videos: number; views: number }> }>();
  const bucketEmpty = () => ({ FOR: { videos: 0, views: 0 }, AGAINST: { videos: 0, views: 0 }, NONE: { videos: 0, views: 0 } });

  for (const video of videos) {
    const normalized = index.normalizedByVideo.get(video.id) ?? "";
    let best: { id: string; label: string; score: number } | null = null;
    for (const family of READING_FAMILIES) {
      const score = family.terms.reduce((total, term) => total + (normalized.includes(term) ? 1 : 0), 0);
      if (score > 0 && (!best || score > best.score)) best = { id: family.id, label: family.label, score };
    }
    const reading = best ?? OTHER_READING;
    const bucket = bucketOf(primaryStance(index, video.id)?.label);
    if (!readings.has(reading.id)) {
      readings.set(reading.id, { id: reading.id, label: reading.label, videos: 0, views: 0, buckets: bucketEmpty() });
    }
    const node = readings.get(reading.id)!;
    node.videos++;
    node.views += viewsOf(video);
    node.buckets[bucket].videos++;
    node.buckets[bucket].views += viewsOf(video);
  }

  // Keep the four largest named readings; fold the long tail and any videos
  // that matched no family into a single "Other readings" node. Keeping at most
  // one "other" node is what makes the verdict totals add up to 100%.
  const otherNode = readings.get("other");
  const ranked = [...readings.values()].filter((node) => node.id !== "other").sort((a, b) => b.videos - a.videos);
  const kept = ranked.slice(0, 4);
  const tail = [...ranked.slice(4), ...(otherNode ? [otherNode] : [])];
  if (tail.length > 0) {
    const merge = { id: "other", label: OTHER_READING.label, videos: 0, views: 0, buckets: bucketEmpty() };
    for (const node of tail) {
      merge.videos += node.videos;
      merge.views += node.views;
      for (const key of ["FOR", "AGAINST", "NONE"] as VerdictBucket[]) {
        merge.buckets[key].videos += node.buckets[key].videos;
        merge.buckets[key].views += node.buckets[key].views;
      }
    }
    kept.push(merge);
  }
  const ordered = kept;

  const verdictNodes: Record<VerdictBucket, { videos: number; views: number }> = {
    FOR: { videos: 0, views: 0 },
    AGAINST: { videos: 0, views: 0 },
    NONE: { videos: 0, views: 0 },
  };
  for (const node of ordered) {
    for (const key of ["FOR", "AGAINST", "NONE"] as VerdictBucket[]) {
      verdictNodes[key].videos += node.buckets[key].videos;
      verdictNodes[key].views += node.buckets[key].views;
    }
  }

  const nodes = [
    { id: "fact", label: fact.category, column: 0, videos: videos.length, views: videos.reduce((total, video) => total + viewsOf(video), 0) },
    ...ordered.map((node) => ({ id: `reading:${node.id}`, label: node.label, column: 1, videos: node.videos, views: node.views })),
    ...(["FOR", "AGAINST", "NONE"] as VerdictBucket[])
      .filter((key) => verdictNodes[key].videos > 0)
      .map((key) => ({
        id: `verdict:${key}`,
        label: key === "FOR" ? "For a candidate" : key === "AGAINST" ? "Against a candidate" : "No side",
        column: 2,
        videos: verdictNodes[key].videos,
        views: verdictNodes[key].views,
      })),
  ];

  const links = [
    ...ordered.map((node) => ({ source: "fact", target: `reading:${node.id}`, videos: node.videos, views: node.views })),
    ...ordered.flatMap((node) =>
      (["FOR", "AGAINST", "NONE"] as VerdictBucket[])
        .filter((key) => node.buckets[key].videos > 0)
        .map((key) => ({ source: `reading:${node.id}`, target: `verdict:${key}`, videos: node.buckets[key].videos, views: node.buckets[key].views })),
    ),
  ];

  const total = videos.length || 1;
  const pct = (value: number) => Number(((value / total) * 100).toFixed(1));
  // Round two bands and derive the third so the printed shares always sum to 100.
  const forPct = pct(verdictNodes.FOR.videos);
  const againstPct = pct(verdictNodes.AGAINST.videos);
  const nonePct = Number((100 - forPct - againstPct).toFixed(1));
  const top = ordered.slice().sort((a, b) => b.videos - a.videos)[0];

  return {
    nodes,
    links,
    summary: {
      videos: videos.length,
      forPct,
      againstPct,
      nonePct,
      topReading: top ? top.label : null,
    },
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

// ── Fact timeline ("When each fact came up") ────────────────────────────────

const MOMENT_LABEL: Record<string, string> = {
  lepen_conviction_ineligibility: "Court ruling",
  candidate_declarations: "Announcement",
  medef_ref_debate: "Debate",
  protest_17_october: "Protest",
  socialist_primary_glucksmann: "Primary",
  rn_antisemitism_row: "Antisemitism row",
  police_custody_igpn: "Police custody",
  adele_haenel_censorship: "Censorship",
  lycee_blockades_uni: "Lycée blockades",
  paris_massacre_1961: "1961 memory",
  pensions_reform: "Pensions",
  immigration_oqtf: "Immigration",
  budget_deficit_493: "Budget",
  purchasing_power_smic: "Purchasing power",
  hospital_health: "Health",
  heatwaves_fires: "Heatwaves",
  housing_rents: "Housing",
  strikes_demonstrations: "Strikes",
  ukraine_russia: "Ukraine",
  palestine_gaza: "Middle East",
};

const KIND_LABEL: Record<string, string> = {
  scandal: "Scandal",
  policy: "Policy",
  campaign: "Campaign",
  society: "Society",
  international: "World",
};

const MOMENT_KIND: Record<string, string> = {
  scandal: "scandal",
  policy: "policy",
  campaign: "campaign",
  society: "society",
  international: "world",
  government: "government",
  media: "media",
};

const dateOf = (video: VideoRow) => video.posted_at.slice(0, 10);
const monthName = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

/**
 * For one fact: the news moments it travelled with, the other facts cited in the
 * same 3-day burst, and the verdict split the fact drew there.
 *
 * The burst window is the densest `windowDays` stretch within a week of the
 * event's first coverage — a single quiet day should not define a moment.
 */
const MOMENT_DATE: Record<string, string> = {
  // The corpus names the day; coverage peaked three days later, so use the event date.
  protest_17_october: "2026-10-17",
};

/**
 * For one fact: the news moments it travelled with, the other facts cited in the
 * same window, and the verdict split the fact drew there.
 *
 * A moment is one calendar day (the event's own date when the corpus names it,
 * otherwise its first covered day) plus `windowDays` centred on it. Moments are
 * ranked by whether the selected fact appears, then by volume, so a fact's own
 * appearances are never crowded out by unrelated news.
 */
function buildFactTimelineUncached(index: Index, fact: FactDef, windowDays = 3) {
  const citations = new Map<string, Set<string>>();
  for (const item of index.dataset.facts) {
    citations.set(item.id, new Set(factVideos(index, item).map((video) => video.id)));
  }
  const selected = citations.get(fact.id) ?? new Set<string>();
  const dated = index.dataset.videos.filter((video) => video.posted_at);
  const half = Math.floor(windowDays / 2);

  const candidates = [] as any[];
  for (const event of index.dataset.events.events as any[]) {
    const anchor = MOMENT_DATE[event.id] ?? event.commencement;
    if (!anchor) continue;
    const from = addDays(anchor, -half);
    const to = addDays(anchor, windowDays - 1 - half);
    const windowVideos = dated.filter((video) => dateOf(video) >= from && dateOf(video) <= to);
    // A moment exists only if this fact was actually cited in it; otherwise every
    // fact would show the same news calendar.
    const citing = windowVideos.filter((video) => selected.has(video.id));
    if (citing.length === 0) continue;

    const chips = index.dataset.facts
      .map((item) => ({
        id: item.id,
        label: item.category,
        videos: windowVideos.filter((video) => citations.get(item.id)!.has(video.id)).length,
        highlighted: item.id === fact.id,
      }))
      .sort((a, b) => b.videos - a.videos);
    const selectedChip = chips.find((chip) => chip.highlighted)!;
    // "Highlighted wherever it appeared": a fact with no coverage in this window
    // is omitted rather than shown as a filled chip reading zero.
    const shown = [
      ...chips.filter((chip) => !chip.highlighted && chip.videos > 0).slice(0, 3),
      ...(selectedChip.videos > 0 ? [selectedChip] : []),
    ].sort((a, b) => b.videos - a.videos);

    const verdicts = { forCandidate: 0, againstCandidate: 0, noSide: 0 };
    for (const video of windowVideos) {
      if (!selected.has(video.id)) continue;
      const row = primaryStance(index, video.id);
      if (row?.label === "favorable") verdicts.forCandidate += 1;
      else if (row?.label === "critical") verdicts.againstCandidate += 1;
      else verdicts.noSide += 1;
    }

    candidates.push({
      id: event.id,
      date: anchor,
      month: monthName(anchor),
      kind: MOMENT_KIND[event.kind] ?? "event",
      label: MOMENT_LABEL[event.id] ?? KIND_LABEL[event.kind] ?? "Event",
      title: event.title,
      windowStart: from,
      windowEnd: to,
      videos: citing.length,
      totalVideos: windowVideos.length,
      facts: shown,
      verdicts,
      hasSelectedFact: citing.length > 0,
      _presence: selectedChip.videos,
      _own: windowVideos.filter((video) => (event.video_ids ?? []).includes(video.id)).length,
    });
  }

  // One node per calendar day: keep the event that best represents it.
  const byDate = new Map<string, any>();
  for (const moment of candidates) {
    const current = byDate.get(moment.date);
    if (
      !current ||
      moment._presence > current._presence ||
      (moment._presence === current._presence && moment._own > current._own)
    ) {
      byDate.set(moment.date, moment);
    }
  }

  const kept = [...byDate.values()]
    .sort((a, b) => b._presence - a._presence || b._own - a._own)
    .slice(0, 8)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(({ _presence, _own, ...moment }) => moment);

  const months: string[] = [];
  for (const moment of kept) if (!months.includes(moment.month)) months.push(moment.month);

  return {
    factId: fact.id,
    fact: { id: fact.id, category: fact.category, statement: fact.statement, videos: selected.size },
    windowDays,
    months,
    moments: kept,
    videosInBursts: kept.reduce((sum, moment) => sum + moment.videos, 0),
    totalVideosInBursts: kept.reduce((sum, moment) => sum + moment.totalVideos, 0),
  };
}

// ── "The videos behind the numbers" ─────────────────────────────────────────

export interface BehindItem {
  video: VideoRow;
  fact: { id: string; category: string; statement: string };
  candidate: { id: string; name: string } | null;
  leaning: "FAVORABLE" | "CRITICAL" | "NEUTRAL";
}

const VERDICT_OF: Record<string, BehindItem["leaning"]> = {
  favorable: "FAVORABLE",
  critical: "CRITICAL",
  neutral: "NEUTRAL",
};

/**
 * The strip under the Sankey: videos that carry both a fact and a verdict that
 * survived the verbatim check. One per creator and one per fact when possible,
 * so the row reads as variety rather than one account's output.
 */
function buildBehindTheNumbersUncached(
  index: Index,
  options: { limit?: number; factId?: string } = {},
): BehindItem[] {
  const limit = options.limit ?? 6;
  const citations = new Map<string, FactDef[]>();
  for (const fact of index.dataset.facts) {
    for (const video of factVideos(index, fact)) {
      const list = citations.get(video.id) ?? [];
      list.push(fact);
      citations.set(video.id, list);
    }
  }

  const target = (row: StanceRow) => {
    const candidate = index.candidateById.get(row.candidate_id);
    return candidate ? { id: candidate.id, name: candidate.name } : null;
  };

  const pool: BehindItem[] = [];
  for (const video of index.dataset.videos) {
    const row = primaryStance(index, video.id);
    if (!row) continue;
    const leaning = VERDICT_OF[row.label];
    if (!leaning) continue; // unclear never appears in this strip
    const verified = row.evidence_mode === "exact" || row.evidence_mode === "fuzzy";
    if (!verified || !row.quote) continue;
    const facts = citations.get(video.id) ?? [];
    if (options.factId) {
      const match = facts.find((fact) => fact.id === options.factId);
      if (!match) continue;
      pool.push({ video, fact: { id: match.id, category: match.category, statement: match.statement }, candidate: target(row), leaning });
      continue;
    }
    if (facts.length === 0) continue;
    const fact = facts[0];
    pool.push({ video, fact: { id: fact.id, category: fact.category, statement: fact.statement }, candidate: target(row), leaning });
  }

  pool.sort((a, b) => (b.video.views ?? 0) - (a.video.views ?? 0));

  const picked: BehindItem[] = [];
  const handles = new Set<string>();
  const facts = new Set<string>();
  const take = (item: BehindItem) => {
    picked.push(item);
    handles.add(item.video.creator_handle);
    facts.add(item.fact.id);
  };

  // Balance the strip: equal quota per verdict, then fill. Sorting by views
  // alone produced a row that was almost entirely critical.
  const order: BehindItem["leaning"][] = ["FAVORABLE", "CRITICAL", "NEUTRAL"];
  const quota = Math.ceil(limit / order.length);
  // With fewer slots than leanings there is nothing to balance: take the reach.
  if (limit >= order.length) for (const leaning of order) {
    let taken = 0;
    for (const item of pool) {
      if (picked.length >= limit || taken >= quota) break;
      if (item.leaning !== leaning || picked.includes(item)) continue;
      if (handles.has(item.video.creator_handle) || facts.has(item.fact.id)) continue;
      take(item);
      taken += 1;
    }
  }
  for (const item of pool) {
    if (picked.length >= limit) break;
    if (handles.has(item.video.creator_handle) || picked.includes(item)) continue;
    take(item);
  }
  for (const item of pool) {
    if (picked.length >= limit) break;
    if (picked.includes(item)) continue;
    take(item);
  }

  return picked.sort((a, b) => (b.video.views ?? 0) - (a.video.views ?? 0));
}

export function buildFact(index: Index, fact: FactDef) {
  return memo(index, `fact:${fact.id}`, () => buildFactUncached(index, fact));
}

export function buildFactTimeline(index: Index, fact: FactDef, windowDays = 3) {
  return memo(index, `timeline:${fact.id}:${windowDays}`, () => buildFactTimelineUncached(index, fact, windowDays));
}

export function buildBehindTheNumbers(
  index: Index,
  options: { limit?: number; factId?: string } = {},
) {
  const key = `behind:${options.limit ?? 6}:${options.factId ?? ""}`;
  return memo(index, key, () => buildBehindTheNumbersUncached(index, options));
}
