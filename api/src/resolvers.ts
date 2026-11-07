import { buildEventInsight, buildFactReadings } from "./derive.ts";
import { buildBehindTheNumbers, buildFact, buildFactTimeline, creatorStance, eventImpact, factVideos, lexicalSearch, stanceOf, videoText } from "./derive.ts";
import { buildAnatomy, selectEntry } from "./anatomy.ts";
import type { Index } from "./derive.ts";
import type { Dataset, EmbeddingClient, FactDef, StanceRow } from "./sources.ts";
import type { VideoRow } from "../../supabase/functions/_shared/types.ts";

export interface Context {
  dataset: Dataset;
  index: Index;
  embeddings: EmbeddingClient;
  factsByVideo: Map<string, FactDef[]>;
}

const LEANING = { favorable: "FAVORABLE", critical: "CRITICAL", neutral: "NEUTRAL", unclear: "UNCLEAR" } as const;
const KINDS = { scandal: "SCANDAL", policy: "POLICY", campaign: "CAMPAIGN", society: "SOCIETY", international: "INTERNATIONAL" } as const;
const PLATFORM = { tiktok: "TIKTOK", instagram: "INSTAGRAM", youtube: "YOUTUBE" } as const;
const leaning = (value: string) => (LEANING as Record<string, string>)[value] ?? "UNCLEAR";
const platform = (value: string) => (PLATFORM as Record<string, string>)[value] ?? "TIKTOK";

const candidateShape = (candidate: any) => candidate && ({
  id: candidate.id,
  name: candidate.name,
  party: candidate.party ?? null,
  partyShort: candidate.partyShort ?? null,
  tier: candidate.tier ?? "minor",
  status: candidate.status ?? "declared",
  statusNote: candidate.statusNote ?? null,
  communities: candidate.communities ?? [],
});

const confidence = (row: StanceRow): string => {
  if (row.basis?.includes("unverified")) return "held_out";
  if (row.label === "unclear") return "low";
  if (row.evidence_mode === "exact" && Math.abs(row.score) >= 0.5) return "high";
  if (row.evidence_mode === "fuzzy" || Math.abs(row.score) >= 0.3) return "medium";
  return "low";
};

const verdictShape = (ctx: Context, row: StanceRow) => ({
  candidate: candidateShape(ctx.index.candidateById.get(row.candidate_id)),
  leaning: leaning(row.label),
  confidence: confidence(row),
  quote: row.quote || null,
  source: row.basis ?? null,
  verified: row.evidence_mode === "exact" || row.evidence_mode === "fuzzy",
  heldOut: (row.basis ?? "").includes("unverified"),
});

const videoShape = (ctx: Context, video: VideoRow) => ({
  id: video.id,
  url: video.url,
  platform: platform(video.platform),
  postedAt: video.posted_at ?? null,
  creator: creatorShape(ctx, video.creator_handle ?? "unknown"),
  views: video.views ?? 0,
  likes: video.likes ?? 0,
  interactions: video.interactions ?? 0,
  format: video.format,
  platformFormat: video.platform_format ?? "video",
  durationSeconds: video.duration_seconds ?? null,
  thumbnailUrl: video.thumbnail_url ?? null,
  caption: video.caption ?? null,
  transcript: video.transcript ?? null,
  onScreenText: video.on_screen_text ?? [],
  isFrench: Boolean(video.is_french),
  verdicts: (ctx.index.stanceByVideo.get(video.id) ?? []).map((row) => verdictShape(ctx, row)),
  facts: (ctx.factsByVideo.get(video.id) ?? []).map((fact) => ({ fact: factShape(ctx, fact), story: null })),
  candidates: ctx.dataset.candidates
    .filter((candidate) => (ctx.index.videosByCandidate.get(candidate.id) ?? []).some((item) => item.id === video.id))
    .map(candidateShape),
});

function creatorShape(ctx: Context, handle: string) {
  const videos = ctx.dataset.videos.filter((video) => (video.creator_handle ?? "unknown") === handle);
  const first = videos[0];
  return {
    handle,
    displayName: first?.creator_display_name ?? null,
    followers: first?.creator_followers ?? null,
    verified: first?.creator_verified ?? null,
    platforms: [...new Set(videos.map((video) => platform(video.platform)))],
    _videos: videos,
  };
}

const anatomyShape = (ctx: Context, anatomy: any) => ({
  ...anatomy,
  attribution: { ...anatomy.attribution, platform: platform(anatomy.attribution.platform) },
  verdict: anatomy.verdict
    ? { ...anatomy.verdict, leaning: leaning(anatomy.verdict.leaning), candidate: candidateShape(ctx.index.candidateById.get(anatomy.verdict.candidateId)) }
    : null,
  video: ctx.index.videoById.get(anatomy.videoId)
    ? videoShape(ctx, ctx.index.videoById.get(anatomy.videoId)!)
    : null,
});

const eventShape = (ctx: Context, event: any) => ({
  id: event.id,
  title: event.title,
  category: event.category,
  kind: KINDS[event.kind as keyof typeof KINDS] ?? "SOCIETY",
  majorIssue: event.major_issue,
  subIssue: event.sub_issue,
  isScandal: Boolean(event.is_scandal),
  commencement: event.commencement,
  commencementBasis: event.commencement_basis ?? "first_covered_video",
  peakDate: event.peak_date,
  peakVideos: event.peak_videos ?? 0,
  lastCoveredAt: event.last_covered_at,
  durationDays: event.duration_days ?? 0,
  activeDays: event.active_days ?? 0,
  videos: event.videos,
  creators: event.creators,
  confidence: event.confidence,
  timeline: (event.timeline ?? []).map((bucket: any) => ({
    date: bucket.date,
    videos: bucket.videos,
    candidates: Object.keys(bucket.candidates ?? {}),
  })),
  topicBreakdown: (event.topic_breakdown ?? []).map((row: any) => ({ topic: row.topic, videos: row.videos })),
  candidates: (event.candidates ?? []).map((row: any) => ({
    candidate: candidateShape(ctx.index.candidateById.get(row.id)),
    videos: row.videos,
  })),
  notes: event.notes ?? null,
  _event: event,
});

const factShape = (ctx: Context, fact: FactDef) => {
  const built = buildFact(ctx.index, fact);
  return {
    id: fact.id,
    statement: fact.statement,
    category: fact.category,
    sourceName: fact.sourceName,
    sourceUrl: fact.sourceUrl,
    verified: fact.verified,
    reviewStatus: fact.reviewStatus,
    videos: built.videos.length,
    creators: built.creators,
    stories: built.stories,
    aimedAt: built.aimedAt.map((row) => ({
      candidate: candidateShape(row.candidate),
      leaning: leaning(row.leaning),
      videos: row.videos,
    })),
    timeline: built.timeline,
    events: built.events.map((event: any) => eventShape(ctx, event)),
    sankey: built.sankey,
    _fact: fact,
    _built: built,
  };
};

const insightShape = (ctx: Context, insight: any) => {
  const impact = (row: any) => ({
    candidate: candidateShape(ctx.index.candidateById.get(row.candidateId)),
    before: row.before,
    after: row.after,
    changePct: row.before > 0 ? Number((((row.after - row.before) / row.before) * 100).toFixed(1)) : null,
    favorableAfter: row.favorableAfterCount,
    criticalAfter: row.criticalAfterCount,
    neutralAfter: row.neutralAfterCount,
    unclearAfter: row.unclearAfterCount,
    beforePerDay: row.beforePerDay,
    afterPerDay: row.afterPerDay,
    multiplier: row.multiplier,
    favorableBeforePerDay: row.favorableBeforePerDay,
    favorableAfterPerDay: row.favorableAfterPerDay,
    criticalBeforePerDay: row.criticalBeforePerDay,
    criticalAfterPerDay: row.criticalAfterPerDay,
  });
  return {
    event: eventShape(ctx, insight.event),
    beforeDays: insight.beforeDays,
    afterDays: insight.afterDays,
    beforeVideos: insight.beforeVideos,
    afterVideos: insight.afterVideos,
    beforePerDay: insight.beforePerDay,
    afterPerDay: insight.afterPerDay,
    multiplier: insight.multiplier,
    impacts: insight.impacts.map(impact),
    biggestFavorable: insight.biggestFavorable ? impact(insight.biggestFavorable) : null,
    biggestCritical: insight.biggestCritical ? impact(insight.biggestCritical) : null,
    facts: insight.facts,
  };
};

export const resolvers = {
  Query: {
    apiVersion: () => "0.1.0",
    dataset: (_: unknown, __: unknown, ctx: Context) => ({
      videos: ctx.dataset.videos.length,
      stanceRows: ctx.dataset.stance.length,
      events: ctx.dataset.events.events.length,
      window: ctx.dataset.events.window,
      origin: ctx.dataset.origin.videos,
    }),
    candidates: (_: unknown, __: unknown, ctx: Context) => ctx.dataset.candidates.map(candidateShape),
    candidate: (_: unknown, args: { id: string }, ctx: Context) => {
      const candidate = ctx.index.candidateById.get(args.id);
      return candidate ? candidateShape(candidate) : null;
    },
    creator: (_: unknown, args: { handle: string }, ctx: Context) => {
      const handle = args.handle.replace(/^@/, "");
      const exists = ctx.dataset.videos.some((video) => (video.creator_handle ?? "unknown") === handle);
      return exists ? creatorShape(ctx, handle) : null;
    },
    video: (_: unknown, args: { id: string }, ctx: Context) => {
      const video = ctx.index.videoById.get(args.id);
      return video ? videoShape(ctx, video) : null;
    },
      eventInsight: (_: unknown, args: { id: string; beforeDays?: number; afterHours?: number }, ctx: Context) => {
      const insight = buildEventInsight(ctx.index, args.id, args.beforeDays ?? 14, args.afterHours ?? 72);
      return insight ? insightShape(ctx, insight) : null;
    },
    eventInsights: (_: unknown, args: { limit?: number; beforeDays?: number; afterHours?: number }, ctx: Context) => {
      // Prefer moments that have a real baseline: a 14-day window inside the
      // start of the corpus makes every multiplier undefined.
      const limit = args.limit ?? 6;
      // Only the busiest moments are candidates; walking all twenty would blow
      // the edge worker's CPU budget.
      const events = [...(ctx.dataset.events.events as any[])]
        .sort((a, b) => (b.videos ?? 0) - (a.videos ?? 0))
        .slice(0, limit);
      return events
        .map((event) => buildEventInsight(ctx.index, event.id, args.beforeDays ?? 14, args.afterHours ?? 72))
        .filter((item) => item !== null)
        .sort((a, b) => (b.beforeVideos - a.beforeVideos) || (b.afterVideos - a.afterVideos))
        .slice(0, args.limit ?? 6)
        .map((item) => insightShape(ctx, item));
    },
    issueGroups: (_: unknown, __: unknown, ctx: Context) =>
      ctx.dataset.events.issue_groups.map((group) => ({
        majorIssue: group.major_issue,
        videos: group.videos,
        subIssues: group.sub_issues.map((sub) => ({
          subIssue: sub.sub_issue,
          videos: sub.videos,
          topics: sub.topics.map((topic: any) => ({ id: topic.id, videos: topic.videos, first: topic.first, last: topic.last })),
          events: sub.events.map((event: any) => ({
            id: event.id,
            videos: event.videos,
            commencement: event.commencement,
            isScandal: Boolean(event.is_scandal),
          })),
        })),
      })),
    facts: (_: unknown, __: unknown, ctx: Context) => ctx.dataset.facts.map((fact) => factShape(ctx, fact)),
    fact: (_: unknown, args: { id: string }, ctx: Context) => {
      const fact = ctx.dataset.facts.find((item) => item.id === args.id);
      return fact ? factShape(ctx, fact) : null;
    },
    story: (_: unknown, args: { factId: string }, ctx: Context) => {
      const fact = ctx.dataset.facts.find((item) => item.id === args.factId);
      return fact ? factShape(ctx, fact) : null;
    },
    search: async (_: unknown, args: { query: string; limit?: number; useEmbeddings?: boolean }, ctx: Context) => {
      const limit = args.limit ?? 20;
      if (args.useEmbeddings && ctx.embeddings.available) {
        const [queryVector] = await ctx.embeddings.embed([args.query]);
        const texts = ctx.dataset.videos.map((video) => videoText(video).slice(0, 1500));
        const vectors = await ctx.embeddings.embed(texts);
        const { cosine } = await import("./derive.ts");
        return ctx.dataset.videos
          .map((video, position) => ({ video, score: Number(cosine(queryVector, vectors[position]).toFixed(4)) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((hit) => ({ video: videoShape(ctx, hit.video), score: hit.score, method: "embedding" }));
      }
      return lexicalSearch(ctx.index, args.query, limit).map((hit) => ({
        video: videoShape(ctx, hit.video),
        score: hit.score,
        method: "lexical",
      }));
    },
    anatomy: (_: unknown, args: { videoId: string }, ctx: Context) => {
      const anatomy = buildAnatomy(ctx.index, args.videoId, ctx.dataset.facts);
      return anatomy && anatomyShape(ctx, anatomy);
    },
    entryPage: (_: unknown, args: { limit?: number }, ctx: Context) =>
      selectEntry(ctx.index, args.limit ?? 6).map((item) => anatomyShape(ctx, item.anatomy)),
    behindTheNumbers: (_: unknown, args: { limit?: number; factId?: string }, ctx: Context) =>
      buildBehindTheNumbers(ctx.index, { limit: args.limit ?? 6, factId: args.factId }).map((item) => ({
        video: videoShape(ctx, item.video),
        fact: item.fact,
        candidate: item.candidate,
        leaning: item.leaning,
      })),
    factTimeline: (_: unknown, args: { factId: string; windowDays?: number }, ctx: Context) => {
      const fact = ctx.dataset.facts.find((item) => item.id === args.factId);
      return fact ? buildFactTimeline(ctx.index, fact, args.windowDays ?? 3) : null;
    },
    factTimelines: (_: unknown, args: { windowDays?: number }, ctx: Context) =>
      ctx.dataset.facts.map((fact) => buildFactTimeline(ctx.index, fact, args.windowDays ?? 3)),
    timeline: (_: unknown, args: { factId?: string }, ctx: Context) => {
      if (args.factId) {
        const fact = ctx.dataset.facts.find((item) => item.id === args.factId);
        return fact ? buildFact(ctx.index, fact).timeline : [];
      }
      return ctx.dataset.events.events
        .flatMap((event) => event.timeline.map((bucket: any) => ({ ...bucket, event: event.id })))
        .reduce((acc: any[], bucket: any) => {
          const existing = acc.find((row) => row.date === bucket.date);
          if (existing) existing.videos += bucket.videos;
          else acc.push({ date: bucket.date, videos: bucket.videos, candidates: Object.keys(bucket.candidates ?? {}) });
          return acc;
        }, [])
        .sort((a: any, b: any) => (a.date < b.date ? -1 : 1));
    },
  },
  Creator: {
    videos: (parent: any, args: { limit?: number }, ctx: Context) =>
      (parent._videos ?? []).slice(0, args.limit ?? 20).map((video: VideoRow) => videoShape(ctx, video)),
    stanceByCandidate: (parent: any, args: { minVideos?: number }, ctx: Context) =>
      creatorStance(ctx.index, parent.handle, args.minVideos ?? 2).map((row) => ({
        candidate: candidateShape(row.candidate),
        videos: row.videos,
        favorable: row.favorable,
        critical: row.critical,
        neutral: row.neutral,
        unclear: row.unclear,
        stanceIndex: row.stanceIndex,
        viewWeightedIndex: row.viewWeightedIndex,
        label: row.label,
        evidence: row.evidence,
      })),
  },
  Event: {
    evidence: (parent: any, args: { limit?: number }) =>
      (parent._event.evidence ?? []).slice(0, args.limit ?? 4).map((item: any) => ({
        videoId: item.video_id,
        creator: item.creator_handle,
        platform: platform(item.platform),
        postedAt: item.posted_at,
        views: item.views ?? 0,
        quote: item.quote,
        matchedAnchors: item.matched_anchors ?? [],
        url: item.url,
      })),
  },
  Fact: {
    leaningTotals: (parent: any, _args: unknown, ctx: Context) => {
      const fact: FactDef | undefined = parent._fact;
      if (!fact) return { favorable: 0, critical: 0, neutral: 0, videos: 0 };
      return buildFactReadings(ctx.index, fact).reduce(
        (sum, reading) => ({
          favorable: sum.favorable + reading.favorable,
          critical: sum.critical + reading.critical,
          neutral: sum.neutral + reading.neutral,
          videos: sum.videos + reading.videos,
        }),
        { favorable: 0, critical: 0, neutral: 0, videos: 0 },
      );
    },
    readings: (parent: any, _args: unknown, ctx: Context) => {
      const fact: FactDef | undefined = parent._fact;
      if (!fact) return [];
      return buildFactReadings(ctx.index, fact).map((reading) => ({
        id: reading.id,
        label: reading.label,
        videos: reading.videos,
        favorable: reading.favorable,
        critical: reading.critical,
        neutral: reading.neutral,
        views: reading.views,
        dominant: leaning(reading.dominant),
        representatives: reading.representativeIds
          .map((videoId) => buildAnatomy(ctx.index, videoId, ctx.dataset.facts))
          .filter((item) => item !== null)
          .map((item) => anatomyShape(ctx, item!)),
      }));
    },
    videosList: (parent: any, args: { limit?: number }, ctx: Context) =>
      (parent._built?.videos ?? []).slice(0, args.limit ?? 20).map((video: VideoRow) => videoShape(ctx, video)),
    timeline: (parent: any) => parent._built?.timeline ?? [],
    stories: (parent: any) => parent._built?.stories ?? [],
  },
  FactStory: {
    videosList: (parent: any, args: { limit?: number }, ctx: Context) =>
      (parent.ids ?? []).slice(0, args.limit ?? 10)
        .map((id: string) => ctx.index.videoById.get(id))
        .filter(Boolean)
        .map((video: VideoRow) => videoShape(ctx, video)),
  },
  Video: {
    verdicts: (parent: any) => parent.verdicts,
  },
  CandidateImpact: {
    candidate: (parent: any) => parent.candidate,
  },
};

export { factVideos, stanceOf, videoText };
