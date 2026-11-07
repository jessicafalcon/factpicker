/**
 * The only data access in the app: one GraphQL call per page render.
 * Server-side only, so the browser never talks to the API directly and there is
 * no CORS surface to configure.
 */
export type AnatomyRole = "OPENING" | "FACT" | "MEANING" | "VERDICT";

export interface AnatomyStyle {
  underline: "none" | "solid" | "dotted";
  tone: "ink" | "ochre";
  fill: boolean;
  className: string;
  legend: string;
  description: string;
}

export interface AnatomySegment {
  role: AnatomyRole;
  text: string;
  source: string;
  truncated: boolean;
  style: AnatomyStyle;
}

export interface AnatomyItem {
  videoId: string;
  composed: string;
  coverage: string;
  quality: number;
  fact: { id: string; statement: string; sourceName: string | null; verified: boolean } | null;
  verdict: {
    candidateId: string;
    candidate: { id: string; name: string } | null;
    leaning: "FAVORABLE" | "CRITICAL" | "NEUTRAL" | "UNCLEAR";
    verified: boolean;
  } | null;
  attribution: {
    handle: string;
    platform: "TIKTOK" | "INSTAGRAM" | "YOUTUBE";
    platformId: string | null;
    embedUrl: string | null;
    views: number | null;
    postedAt: string | null;
    thumbnailUrl: string | null;
    url: string;
    format: string;
  };
  segments: AnatomySegment[];
}

export interface SankeyNode {
  id: string;
  label: string;
  column: number;
  videos: number;
  views: number;
}

export interface SankeyLink {
  source: string;
  target: string;
  videos: number;
  views: number;
}

export interface Sankey {
  nodes: SankeyNode[];
  links: SankeyLink[];
  summary: { videos: number; forPct: number; againstPct: number; nonePct: number; topReading: string | null };
}

export interface FactItem {
  id: string;
  statement: string;
  category: string;
  videos: number;
  sankey: Sankey;
}

export interface TimelineChip {
  id: string;
  label: string;
  videos: number;
  highlighted: boolean;
}

export interface VerdictSplit {
  forCandidate: number;
  againstCandidate: number;
  noSide: number;
}

export interface TimelineMoment {
  id: string;
  date: string;
  month: string;
  kind: string;
  label: string;
  title: string;
  windowStart: string;
  windowEnd: string;
  videos: number;
  totalVideos: number;
  hasSelectedFact: boolean;
  facts: TimelineChip[];
  verdicts: VerdictSplit;
}

export interface FactTimeline {
  factId: string;
  windowDays: number;
  months: string[];
  videosInBursts: number;
  totalVideosInBursts: number;
  fact: { id: string; category: string; statement: string; videos: number };
  moments: TimelineMoment[];
}

export interface BehindItem {
  leaning: "FAVORABLE" | "CRITICAL" | "NEUTRAL";
  fact: { id: string; category: string; statement: string };
  candidate: { id: string; name: string } | null;
  video: {
    id: string;
    url: string;
    thumbnailUrl: string | null;
    views: number | null;
    platform: "TIKTOK" | "INSTAGRAM" | "YOUTUBE";
    creator: { handle: string };
  };
}

export interface DatasetInfo {
  videos: number;
  stanceRows: number;
  events: number;
  window: { first: string; last: string };
  origin: string;
}

const QUERY = `query EntryPage($limit: Int!) {
  apiVersion
  dataset { videos stanceRows events window { first last } origin }
  entryPage(limit: $limit) {
    videoId
    composed
    coverage
    quality
    fact { id statement sourceName verified }
    verdict { candidateId candidate { id name } leaning verified }
    attribution { handle platform platformId embedUrl views postedAt thumbnailUrl url format }
    segments {
      role
      text
      source
      truncated
      style { underline tone fill className legend description }
    }
  }
  facts {
    id
    statement
    category
    videos
    sankey {
      nodes { id label column videos views }
      links { source target videos views }
      summary { videos forPct againstPct nonePct topReading }
    }
  }
  behindTheNumbers(limit: 6) {
    leaning
    candidate { id name }
    fact { id category statement }
    video { id url thumbnailUrl views platform creator { handle } }
  }
  factTimelines {
    factId
    windowDays
    months
    videosInBursts
    totalVideosInBursts
    fact { id category statement videos }
    moments {
      id
      date
      month
      kind
      label
      title
      windowStart
      windowEnd
      videos
      totalVideos
      hasSelectedFact
      facts { id label videos highlighted }
      verdicts { forCandidate againstCandidate noSide }
    }
  }
}`;

export interface EntryPageResult {
  items: AnatomyItem[];
  facts: FactItem[];
  timelines: FactTimeline[];
  behind: BehindItem[];
  dataset: DatasetInfo | null;
  apiVersion: string | null;
  error: string | null;
  endpoint: string;
}

export async function fetchEntryPage(limit = 6): Promise<EntryPageResult> {
  // No deployment URLs in the source: set API_URL wherever the app is hosted.
  const endpoint =
    process.env.API_URL ??
    (process.env.VERCEL
      ? ""
      : "http://localhost:8787/graphql");
  if (!endpoint) {
    throw new Error(
      "API_URL is not set. Point it at your GraphQL endpoint, e.g. https://<project-ref>.supabase.co/functions/v1/graphql",
    );
  }
  try {
    // The edge function can cold-start in a few seconds; retry once before
    // showing the error state, and never let a slow start look like an outage.
    let payload: { data?: Record<string, unknown>; errors?: Array<{ message: string }> } | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2 && !payload; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: QUERY, variables: { limit } }),
          cache: "no-store",
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
        const body = (await response.json()) as {
          data?: Record<string, unknown>;
          errors?: Array<{ message: string }>;
        };
        if (body.errors?.length) throw new Error(body.errors[0].message);
        payload = body;
      } catch (error) {
        lastError = error;
      }
    }
    if (!payload) throw lastError ?? new Error("API unavailable");
    const data = payload.data ?? {};
    return {
      items: (data.entryPage ?? []) as AnatomyItem[],
      facts: (data.facts ?? []) as FactItem[],
      timelines: (data.factTimelines ?? []) as FactTimeline[],
      behind: (data.behindTheNumbers ?? []) as BehindItem[],
      dataset: data.dataset as DatasetInfo,
      apiVersion: data.apiVersion as string,
      error: null,
      endpoint,
    };
  } catch (error) {
    return {
      items: [],
      facts: [],
      timelines: [],
      behind: [],
      dataset: null,
      apiVersion: null,
      error: (error as Error).message,
      endpoint,
    };
  }
}

// ── Pages 2 and 3 ──────────────────────────────────────────────────────────

export async function gqlFetch<T>(query: string, variables: Record<string, unknown> = {}): Promise<T | null> {
  const endpoint =
    process.env.API_URL ?? (process.env.VERCEL ? "" : "http://localhost:8787/graphql");
  if (!endpoint) return null;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { data?: T; errors?: unknown[] };
    return payload.errors?.length ? null : (payload.data ?? null);
  } catch {
    return null;
  }
}

export interface Impact {
  candidate: { id: string; name: string };
  beforePerDay: number;
  afterPerDay: number;
  multiplier: number | null;
  favorableAfter: number;
  criticalAfter: number;
  neutralAfter: number;
  favorableBeforePerDay: number;
  favorableAfterPerDay: number;
  criticalBeforePerDay: number;
  criticalAfterPerDay: number;
}

export interface Insight {
  afterDays: number;
  afterVideos: number;
  multiplier: number | null;
  impacts: Impact[];
  biggestFavorable: Impact | null;
  biggestCritical: Impact | null;
  facts: Array<{ id: string; label: string; videos: number }>;
  event: { id: string; title: string; kind: string; commencement: string };
}

export const INSIGHT_FIELDS = `
  afterDays afterVideos multiplier
  event { id title kind commencement }
  facts { id label videos }
  impacts { candidate { id name } beforePerDay afterPerDay multiplier favorableAfter criticalAfter neutralAfter favorableBeforePerDay favorableAfterPerDay criticalBeforePerDay criticalAfterPerDay }
  biggestFavorable { candidate { id name } beforePerDay afterPerDay favorableBeforePerDay favorableAfterPerDay }
  biggestCritical { candidate { id name } beforePerDay afterPerDay criticalBeforePerDay criticalAfterPerDay }
`;

export async function fetchEventInsights(limit = 6): Promise<Insight[]> {
  const data = await gqlFetch<{ eventInsights: Insight[] }>(
    `query($limit: Int!) { eventInsights(limit: $limit) { ${INSIGHT_FIELDS} } }`,
    { limit },
  );
  return data?.eventInsights ?? [];
}

export interface Reading {
  label: string;
  videos: number;
  favorable: number;
  critical: number;
  neutral: number;
  dominant: "FAVORABLE" | "CRITICAL" | "NEUTRAL";
  representatives: Array<{
    composed: string;
    segments: Array<{ role: string; text: string; truncated: boolean; style: { className: string } }>;
    attribution: { handle: string; platform: string; views: number | null; postedAt: string | null; url: string };
    verdict: { candidate: { name: string } | null; leaning: string } | null;
  }>;
}

export interface FactPage {
  id: string;
  category: string;
  statement: string;
  sourceName: string | null;
  verified: boolean;
  videos: number;
  leaningTotals: { favorable: number; critical: number; neutral: number; videos: number };
  readings: Reading[];
}

export async function fetchFactsPage(): Promise<FactPage[]> {
  const data = await gqlFetch<{ facts: FactPage[] }>(`{
    facts {
      id category statement sourceName verified videos
      leaningTotals { favorable critical neutral videos }
      readings {
        label videos favorable critical neutral dominant
        representatives {
          composed
          segments { role text truncated style { className } }
          attribution { handle platform views postedAt url }
          verdict { candidate { name } leaning }
        }
      }
    }
  }`);
  return data?.facts ?? [];
}
